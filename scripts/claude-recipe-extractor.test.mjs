import assert from 'node:assert/strict';
import test from 'node:test';
import { extractWithClaude } from './claude-recipe-extractor.mjs';

const API_KEY = 'sk-ant-test-private-key-never-log';
const SOURCES = [{
  url: 'https://recipes.example.com/quick-rice',
  title: 'Quick Rice',
  text: 'Quick Rice\n1 cup rice\n2 cups water\nRinse the rice.\nSimmer for 15 minutes.\nRest, covered, for 5 minutes.',
}];
const RECIPE = {
  foundRecipe: true,
  sourceIndex: 0,
  title: 'Quick Rice',
  ingredients: ['1 cup rice', '2 cups water'],
  instructions: ['Rinse the rice.', 'Simmer for 15 minutes.'],
  notes: ['Rest, covered, for 5 minutes.'],
};

function responseFor(value = RECIPE, extra = {}) {
  return new Response(JSON.stringify({
    type: 'message',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...extra,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function options(extra = {}) {
  return { apiKey: API_KEY, sources: SOURCES, fetchImpl: async () => responseFor(), ...extra };
}

function sanitizedFailure(error) {
  assert.equal(error.name, 'ClaudeImportError');
  assert.ok(error.message.trim(), 'errors explain the failure');
  assert.ok(!error.message.includes(API_KEY), 'errors must not disclose the credential');
  assert.ok(!error.message.includes('PRIVATE_PROVIDER_PAYLOAD'), 'raw provider errors must not escape');
  return true;
}

test('disabled or empty imports never call the paid API', async () => {
  const neverFetch = async () => { assert.fail('Claude must not be called'); };
  for (const extra of [
    { apiKey: '' },
    { apiKey: '   ' },
    { sources: [] },
    { sources: [{ url: SOURCES[0].url, title: 'A title only', text: '   ' }] },
  ]) {
    assert.equal(await extractWithClaude(options({ fetchImpl: neverFetch, ...extra })), null);
  }
});

test('uses the fixed Messages API with a private credential and structured output', async () => {
  let calls = 0;
  const result = await extractWithClaude(options({
    model: 'claude-haiku-5-5',
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error', 'the secret cannot follow a redirect');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${API_KEY}`);
      assert.equal(headers.get('anthropic-version'), '2026-10-21');
      assert.equal(headers.get('content-type'), 'application/json');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'claude-haiku-5-5');
      assert.equal(body.max_tokens, 6000);
      assert.equal(body.output_config.format.type, 'json_schema');
      assert.equal(body.output_config.format.schema.additionalProperties, false);
      for (const prohibited of ['temperature', 'top_p', 'top_k', 'tools']) {
        assert.equal(body[prohibited], undefined, `${prohibited} is not required for extraction`);
      }
      assert.ok(body.system, 'page evidence must be separated from extraction instructions');
      assert.ok(!init.body.includes(API_KEY), 'the credential is not prompt content');
      assert.ok(init.signal instanceof AbortSignal);
      return responseFor();
    },
  }));
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    sourceIndex: 0,
    title: RECIPE.title,
    ingredients: RECIPE.ingredients,
    instructions: RECIPE.instructions,
    notes: RECIPE.notes,
  });
});

test('a negative extraction result returns null', async () => {
  assert.equal(await extractWithClaude(options({ fetchImpl: async () => responseFor({
    foundRecipe: false, sourceIndex: 0, title: '', ingredients: [], instructions: [], notes: [],
  }) })), null);
});

test('preserves intentionally repeated recipe steps in their original order', async () => {
  const sources = [{
    ...SOURCES[0],
    text: 'Quick Rice\n1 cup rice\n2 cups water\nAdd rice.\nStir.\nAdd water.\nStir.',
  }];
  const instructions = ['Add rice.', 'Stir.', 'Add water.', 'Stir.'];
  const result = await extractWithClaude(options({
    sources, fetchImpl: async () => responseFor({ ...RECIPE, instructions, notes: [] }),
  }));
  assert.deepEqual(result.instructions, instructions, 'repeating an action later is meaningful');
});

test('normalizes Unicode typography and whitespace when grounding recipe text', async () => {
  const sources = [{
    url: SOURCES[0].url,
    title: 'Grandma’s Rice',
    text: '２ cups\n  water\nStir ’til smooth.\nLet rest.',
  }];
  const recipe = {
    ...RECIPE, title: "Grandma's Rice", ingredients: ['2 cups water'],
    instructions: ["Stir 'til smooth."], notes: ['Let rest.'],
  };
  const result = await extractWithClaude(options({ sources, fetchImpl: async () => responseFor(recipe) }));
  assert.equal(result.sourceIndex, 0);
  assert.equal(result.ingredients.length, 1);
  assert.equal(result.instructions.length, 1);
});

test('keeps the original evidence index when an earlier source is empty', async () => {
  const sources = [
    { url: 'https://recipes.example.com/blank', title: '', text: '' },
    SOURCES[0],
  ];
  const result = await extractWithClaude(options({
    sources, fetchImpl: async () => responseFor({ ...RECIPE, sourceIndex: 1 }),
  }));
  assert.equal(result.sourceIndex, 1);
});

test('rejects fabricated title, ingredients, instructions, and notes', async () => {
  for (const fabricated of [
    { title: 'Imaginary Chocolate Cake' },
    { ingredients: ['8 cups imaginary flour'] },
    { instructions: ['Bake at 999 degrees for 12 hours.'] },
    { notes: ['Contains no allergens.'] },
  ]) {
    await assert.rejects(extractWithClaude(options({
      fetchImpl: async () => responseFor({ ...RECIPE, ...fabricated }),
    })), sanitizedFailure);
  }
});

test('does not combine facts from unrelated selected sources', async () => {
  const sources = [SOURCES[0], {
    url: 'https://recipes.example.com/cake', title: 'Cake', text: '3 cups flour\nBake the cake.',
  }];
  await assert.rejects(extractWithClaude(options({
    sources, fetchImpl: async () => responseFor({ ...RECIPE, ingredients: ['3 cups flour'] }),
  })), sanitizedFailure);
});

test('rejects malformed output shapes and invalid source indexes', async () => {
  for (const value of [
    null,
    [],
    { ...RECIPE, foundRecipe: 'true' },
    { ...RECIPE, sourceIndex: -1 },
    { ...RECIPE, sourceIndex: 0.5 },
    { ...RECIPE, sourceIndex: 1 },
    { ...RECIPE, sourceIndex: '0' },
    { ...RECIPE, title: 12 },
    { ...RECIPE, ingredients: '1 cup rice' },
    { ...RECIPE, ingredients: [null] },
    { ...RECIPE, instructions: [{ text: 'Rinse the rice.' }] },
    { ...RECIPE, notes: null },
  ]) {
    await assert.rejects(extractWithClaude(options({ fetchImpl: async () => responseFor(value) })), sanitizedFailure);
  }
});

test('rejects malformed JSON and missing text blocks', async () => {
  for (const response of [
    new Response('not JSON'),
    responseFor(RECIPE, { content: [{ type: 'text', text: '{"foundRecipe":true,' }] }),
    responseFor(RECIPE, { content: [] }),
    responseFor(RECIPE, { content: [{ type: 'thinking', thinking: 'Private analysis' }] }),
  ]) {
    await assert.rejects(extractWithClaude(options({ fetchImpl: async () => response })), sanitizedFailure);
  }
});

test('refusal and truncated output are failures even if the JSON looks valid', async () => {
  for (const stop_reason of ['max_tokens', 'refusal']) {
    await assert.rejects(extractWithClaude(options({
      fetchImpl: async () => responseFor(RECIPE, { stop_reason }),
    })), sanitizedFailure);
  }
});

test('allows thinking blocks before the final structured text', async () => {
  const result = await extractWithClaude(options({ fetchImpl: async () => responseFor(RECIPE, {
    content: [
      { type: 'thinking', thinking: 'Extracting the public recipe' },
      { type: 'text', text: JSON.stringify(RECIPE) },
    ],
  }) }));
  assert.equal(result.title, RECIPE.title);
});

test('limits evidence to three sources and twenty thousand characters per source', async () => {
  const marker = 'SHOULD_NEVER_REACH_CLAUDE_AFTER_SOURCE_LIMIT';
  const sources = [0, 1, 2, 3].map((index) => ({
    url: `https://recipes.example.com/${index}`,
    title: SOURCES[0].title,
    text: SOURCES[0].text + ' '.repeat(20_000) + `${marker}_${index}`,
  }));
  await extractWithClaude(options({ sources, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    const evidence = JSON.stringify(body.messages);
    assert.ok(!evidence.includes(marker), 'text beyond each source cap is omitted');
    assert.ok(!evidence.includes(sources[3].url), 'the fourth source is omitted');
    return responseFor();
  } }));
  await assert.rejects(extractWithClaude(options({
    sources, fetchImpl: async () => responseFor({ ...RECIPE, sourceIndex: 3 }),
  })), sanitizedFailure);
});

test('empty eligible sources never call Claude even if an excluded source has text', async () => {
  const sources = [0, 1, 2].map((index) => ({
    url: `https://recipes.example.com/${index}`, title: 'Empty source', text: '',
  }));
  sources.push(SOURCES[0]);
  assert.equal(await extractWithClaude(options({
    sources, fetchImpl: async () => { assert.fail('the first three sources contain no text'); },
  })), null);
});

test('grounding uses the truncated evidence actually sent to Claude', async () => {
  const sources = [{
    ...SOURCES[0],
    text: SOURCES[0].text + ' '.repeat(20_000) + '\n4 cups secret sugar',
  }];
  await assert.rejects(extractWithClaude(options({
    sources, fetchImpl: async () => responseFor({ ...RECIPE, ingredients: ['4 cups secret sugar'] }),
  })), sanitizedFailure);
});

test('the model cannot add a new source URL or image URL to the returned draft', async () => {
  const injected = {
    ...RECIPE,
    sourceURL: 'https://attacker.example/collect',
    heroImage: 'http://127.0.0.1/admin',
    attachments: [{ url: 'file:///private' }],
  };
  let result;
  try {
    result = await extractWithClaude(options({ fetchImpl: async () => responseFor(injected) }));
  } catch (error) {
    sanitizedFailure(error);
    return; // Rejecting unknown properties is also safe.
  }
  for (const key of ['sourceURL', 'heroImage', 'attachments']) assert.equal(result[key], undefined);
});

test('provider HTTP errors are sanitized and do not trigger retries', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 529, 302]) {
    let calls = 0;
    await assert.rejects(extractWithClaude(options({ fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: `${API_KEY} PRIVATE_PROVIDER_PAYLOAD` } }), {
        status, headers: { Location: 'https://attacker.example/collect' },
      });
    } })), sanitizedFailure);
    assert.equal(calls, 1, `HTTP ${status} does not cause another paid attempt`);
  }
});

test('network exceptions are sanitized', async () => {
  await assert.rejects(extractWithClaude(options({ fetchImpl: async () => {
    throw new Error(`PRIVATE_PROVIDER_PAYLOAD ${API_KEY}`);
  } })), sanitizedFailure);
});

test('oversized provider response bodies are rejected', async () => {
  const largeResponse = new Response(JSON.stringify({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(RECIPE) }],
    unexpectedPadding: 'x'.repeat(256 * 1024),
  }));
  await assert.rejects(extractWithClaude(options({ fetchImpl: async () => largeResponse })), sanitizedFailure);
});

test('the deadline aborts a stalled HTTP request', { timeout: 2000 }, async () => {
  let aborted = false;
  await assert.rejects(extractWithClaude(options({
    timeoutMs: 20,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }),
  })), sanitizedFailure);
  assert.equal(aborted, true);
});

test('the same deadline covers response body reading', { timeout: 2000 }, async () => {
  let aborted = false;
  await assert.rejects(extractWithClaude(options({
    timeoutMs: 20,
    fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    })),
  })), sanitizedFailure);
  assert.equal(aborted, true);
});

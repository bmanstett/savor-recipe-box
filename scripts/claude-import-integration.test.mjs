import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractRecipeFromHtml, processImportRequest, processPendingRequests } from './process-recipe-imports.mjs';

const URL = 'https://www.allrecipes.com/recipe/9/pan-eggs/'; // no public-reader fallback on this host
const NOW = '2026-11-14T12:00:00.000Z';
const KEY = 'sk-ant-test-private-value';
const PROSE = 'For breakfast you will need 2 eggs and 1 tbsp butter. A warm pan is ready for the butter. The eggs go into the pan. Everything cooks for 3 minutes.';
const HTML = `<html><head><title>Pan Eggs</title><meta property="og:image" content="https://images.example.com/eggs.jpg"></head><body><h1>Pan Eggs</h1><p>${PROSE}</p></body></html>`;
const EXTRACTED = { foundRecipe: true, sourceIndex: 0, title: 'Pan Eggs', ingredients: ['2 eggs', '1 tbsp butter'], instructions: ['A warm pan is ready for the butter.', 'The eggs go into the pan.', 'Everything cooks for 3 minutes.'], notes: [] };
const request = (url = URL) => ({ version: 1, jobId: 'claude-integration', createdAt: NOW, url });
const page = (body, url) => ({ status: 200, headers: { 'content-type': 'text/html' }, body, url: new globalThis.URL(url) });
const answer = (value = EXTRACTED) => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] }));
const options = (extra = {}) => ({ anthropicApiKey: KEY, now: () => NOW, fetchText: async (url) => page(HTML, url), fetchClaude: async () => answer(), ...extra });
const schemaPage = (complete = false) => `<h1>Pan Eggs</h1><p>${PROSE}</p><script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', name: 'Pan Eggs', author: { name: 'Test Cook' }, recipeYield: '2 servings', recipeIngredient: EXTRACTED.ingredients, ...(complete ? { recipeInstructions: EXTRACTED.instructions } : {}) })}</script>`;

test('rescues a prose recipe and preserves original link, photo, and grocery data', async () => {
  const shared = `${URL}?utm_source=phone`;
  let calls = 0;
  const result = await processImportRequest(request(shared), options({ fetchClaude: async (_url, init) => {
    calls++;
    assert.ok(!init.body.includes(KEY));
    return answer();
  } }));
  assert.equal(calls, 1);
  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'claude');
  assert.equal(result.importerVersion, '5');
  assert.equal(result.draft.sourceURL, URL);
  assert.equal(result.sourcesChecked[0].url, shared);
  assert.equal(result.draft.heroImage, 'https://images.example.com/eggs.jpg');
  assert.deepEqual(result.draft.ingredients.map((item) => item.rawText), EXTRACTED.ingredients);
  assert.deepEqual(result.draft.ingredients[0].quantity, { numerator: 2, denominator: 1 });
  assert.ok(result.draft.ingredients.every((item) => item.needsReview));
  assert.equal(result.draft.instructions[2].timerMinutes, 3);
  assert.ok(result.warnings.some((warning) => /Claude extracted/.test(warning)));
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('no key and complete structured recipes make no paid call', async () => {
  const never = async () => { assert.fail('must skip Claude'); };
  const disabled = await processImportRequest(request(), options({ anthropicApiKey: '', fetchClaude: never }));
  assert.equal(disabled.status, 'error');
  const complete = await processImportRequest(request(), options({ fetchText: async (url) => page(schemaPage(true), url), fetchClaude: never }));
  assert.equal(complete.status, 'success');
  assert.equal(complete.provider, 'schema-org');
});

test('completes a partial draft and retains parsed author and servings', async () => {
  const result = await processImportRequest(request(), options({ fetchText: async (url) => page(schemaPage(), url) }));
  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'claude');
  assert.equal(result.draft.author, 'Test Cook');
  assert.equal(result.draft.servings, 2);
  assert.ok(!result.warnings.some((warning) => /Only part/.test(warning)));
});

test('API failures and fabricated answers retain useful partial data', async () => {
  for (const fetchClaude of [
    async () => new Response(`secret=${KEY}`, { status: 401 }),
    async () => answer({ ...EXTRACTED, ingredients: ['99 cups invented ingredient'] }),
    async () => { throw new Error(`network leaked ${KEY}`); },
  ]) {
    const result = await processImportRequest(request(), options({ fetchText: async (url) => page(schemaPage(), url), fetchClaude }));
    assert.equal(result.status, 'partial');
    assert.equal(result.provider, 'schema-org');
    assert.deepEqual(result.draft.ingredients.map((item) => item.rawText), EXTRACTED.ingredients);
    assert.equal(result.draft.instructions.length, 0);
    assert.ok(result.warnings.some((warning) => /Claude/.test(warning)));
    assert.ok(!JSON.stringify(result).includes(KEY));
  }
});

test('does not replace a partial result with fewer ingredients', async () => {
  const result = await processImportRequest(request(), options({ fetchText: async (url) => page(schemaPage(), url), fetchClaude: async () => answer({ ...EXTRACTED, ingredients: ['2 eggs'] }) }));
  assert.equal(result.status, 'partial');
  assert.equal(result.provider, 'schema-org');
  assert.equal(result.draft.ingredients.length, 2);
});

test('paywalls, missing pages, challenge screens, and empty pages do not send evidence to Claude', async () => {
  const paywall = await fs.readFile(new globalThis.URL('./fixtures/recipe-paywalled.html', import.meta.url), 'utf8');
  for (const body of [paywall, '<html><title>Access denied</title><body>Please verify that you are human to access this recipe page.</body></html>', '<html></html>']) {
    const result = await processImportRequest(request(), options({ fetchText: async (url) => page(body, url), fetchClaude: async () => { assert.fail('private/empty text must not call Claude'); } }));
    assert.equal(result.status, 'error');
  }
  const missing = await processImportRequest(request(), options({ fetchText: async () => { throw new Error('HTTP 404'); }, fetchClaude: async () => { assert.fail('missing page must not call Claude'); } }));
  assert.equal(missing.status, 'error');
});

test('public reader prose can be extracted and attributed to the shared page', async () => {
  const source = 'https://recipes.example.com/pan-eggs';
  const result = await processImportRequest(request(source), options({ fetchText: async (url) => page(String(url).startsWith('https://r.jina.ai/') ? JSON.stringify({ data: { title: 'Pan Eggs', content: PROSE } }) : '<h1>Pan Eggs</h1>', url) }));
  assert.equal(result.provider, 'claude');
  assert.equal(result.status, 'success');
  assert.equal(result.draft.sourceURL, source);
});

test('Instagram prose caption keeps its post, creator, and video limitation', async () => {
  const source = 'https://www.instagram.com/reel/CLAUDE1/';
  const embed = `<html><div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/test.cook/">test.cook</a><br>Pan Eggs<br>${PROSE}</div></html>`;
  const result = await processImportRequest(request(source), options({ fetchText: async (url) => {
    if (String(url).includes('/embed/captioned/')) return page(embed, url);
    throw new Error('profile unavailable');
  } }));
  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'claude');
  assert.equal(result.draft.sourceURL, source);
  assert.equal(result.draft.author, '@test.cook');
  assert.ok(result.draft.sourceLinks.some((link) => link.kind === 'creator-profile'));
  assert.ok(result.warnings.some((warning) => /did not transcribe/.test(warning)));
});

function fetchedPage(url, title, text) {
  return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', id: 'fetch-1', name: 'web_fetch', input: { url } },
    { type: 'web_fetch_tool_result', tool_use_id: 'fetch-1', content: {
      type: 'web_fetch_result', url,
      content: { type: 'document', title, source: { type: 'text', media_type: 'text/plain', data: text } },
    } },
  ] }));
}

test('Claude retrieves an Instagram recipe even when ordinary fetching returned no caption', async () => {
  const source = 'https://www.instagram.com/reel/RETRIEVE1/';
  let searches = 0;
  let extractions = 0;
  const result = await processImportRequest(request(source), options({
    fetchText: async () => { throw new Error('public page unavailable'); },
    fetchClaudeRetrieval: async (_url, init) => {
      searches++;
      assert.ok(JSON.parse(init.body).tools.some((tool) => tool.name === 'web_search'));
      return fetchedPage(source, 'Pan Eggs', `Pan Eggs\n${PROSE}`);
    },
    fetchClaude: async () => { extractions++; return answer(); },
  }));
  assert.equal(searches, 1);
  assert.equal(extractions, 1);
  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'claude');
  assert.equal(result.draft.sourceURL, source);
  assert.deepEqual(result.draft.ingredients.map((item) => item.rawText), EXTRACTED.ingredients);
});

test('a discovered access-gated recipe returns its page link without inventing a recipe', async () => {
  const source = 'https://www.instagram.com/reel/GATED1/';
  const recipePage = 'https://cook.example.com/p/chipotle-lime-shredded-beef-chili';
  const title = 'Chipotle lime shredded beef chili';
  const caption = `${title}. My cozy chili is ready! Comment CHILI for access. Recipe: ${recipePage}`;
  const embed = `<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/test.cook/">test.cook</a><br>${caption}</div>`;
  const result = await processImportRequest(request(source), options({
    fetchText: async (url) => {
      if (String(url).includes('/embed/captioned/')) return page(embed, url);
      throw new Error('unavailable');
    },
    fetchClaudeRetrieval: async () => fetchedPage(recipePage, title, `${title}\nIngredients\nContinue reading this post for free, courtesy of the creator.\nClaim my free post\nOr purchase a paid subscription.`),
    fetchClaude: async (_url, init) => {
      assert.ok(!init.body.includes('Claim my free post'), 'gated preview must not be sent for recipe extraction');
      return answer({ foundRecipe: false });
    },
  }));
  assert.equal(result.status, 'error');
  assert.match(result.error, /Claude found the recipe.*requires sign-in or a subscription/);
  assert.ok(result.sourcesChecked.some((item) => item.url === recipePage && item.label === `Recipe found: ${title}`));
  assert.equal(result.draft, undefined);
});

test('readable fetched recipe details survive extraction failures and complete recipes skip extraction', async () => {
  const source = 'https://www.instagram.com/reel/RETAIN1/';
  for (const complete of [false, true]) {
    let calls = 0;
    const text = `Pan Eggs\nIngredients\n2 eggs\n1 tbsp butter${complete ? '\nInstructions\nMelt the butter.\nCook the eggs for 3 minutes.' : ''}`;
    const result = await processImportRequest(request(source), options({
      fetchText: async () => { throw new Error('unavailable'); },
      fetchClaudeRetrieval: async () => fetchedPage(source, 'Pan Eggs', text),
      fetchClaude: async () => { calls++; return new Response('unavailable', { status: 503 }); },
    }));
    assert.equal(calls, complete ? 0 : 1);
    assert.equal(result.status, complete ? 'success' : 'partial');
    assert.deepEqual(result.draft.ingredients.map((item) => item.rawText), ['2 eggs', '1 tbsp butter']);
    assert.equal(result.draft.sourceURL, source);
  }
});

test('access-gated article previews are not mistaken for ingredient lists and use the article title', () => {
  const title = 'Chipotle lime shredded beef chili';
  const html = `<h1 id="wordlogo">The Cooking Newsletter</h1><h1 class="post-title published">${title}</h1>
    <p>For dinner we love 2 bowls of chili and 1 loaf of bread.</p><h2>Ingredients</h2>
    <div class="paywall" data-testid="paywall">Continue reading this post for free. Claim my free post.</div>`;
  const result = extractRecipeFromHtml(html, new globalThis.URL('https://cook.example.com/p/chili'));
  assert.equal(result.paywalled, true);
  assert.equal(result.chosen, null);
  assert.equal(result.title, title);
});

test('missing Claude configuration is explained and makes no retrieval request', async () => {
  const result = await processImportRequest(request('https://www.instagram.com/reel/NOKEY1/'), options({
    anthropicApiKey: '', fetchText: async () => { throw new Error('unavailable'); },
    fetchClaudeRetrieval: async () => { assert.fail('no key must not call Claude'); },
  }));
  assert.equal(result.status, 'error');
  assert.match(result.error, /Claude is not enabled.*ANTHROPIC_API_KEY/);
});

test('queue passes server configuration and never writes its key into results', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'savor-claude-test-'));
  try {
    const requests = path.join(root, 'savor/v1/imports/requests');
    await fs.mkdir(requests, { recursive: true });
    await fs.writeFile(path.join(requests, 'claude-integration.json'), JSON.stringify(request()));
    const summary = await processPendingRequests({ root, ...options({ anthropicModel: 'configured-model', fetchClaude: async (_url, init) => {
      assert.equal(JSON.parse(init.body).model, 'configured-model');
      assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
      return answer();
    } }) });
    assert.equal(summary.success, 1);
    const raw = await fs.readFile(path.join(root, summary.results[0]), 'utf8');
    assert.equal(JSON.parse(raw).provider, 'claude');
    assert.ok(!raw.includes(KEY));
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('savor-claude-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

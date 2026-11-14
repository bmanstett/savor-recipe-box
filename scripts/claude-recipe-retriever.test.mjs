import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveWithClaude } from './claude-recipe-retriever.mjs';

const KEY = 'sk-ant-test-retrieval-never-log';
const POST = 'https://www.instagram.com/reel/DfIoDAaTnSl/';
const CAPTION = 'Chipotle lime shredded beef chili. My cozy dinner recipe.';
const ARTICLE = 'https://whattocook.substack.com/p/chipotle-lime-shredded-beef-chili';
const RECIPE = 'Chipotle lime shredded beef chili\n1 lb beef\n1 lime\nBrown the beef. Add lime.';
const evidence = [{ url: POST, title: 'Caro Chambers', text: CAPTION, creator: '@carochambers' }];
const message = (content, stop_reason = 'end_turn') => ({ type: 'message', stop_reason, content });
const response = (content, stop_reason) => new Response(JSON.stringify(message(content, stop_reason)));
const fetched = (url = POST, text = RECIPE, id = 'fetch1', title = 'Chipotle lime shredded beef chili') => [
  { type: 'server_tool_use', id, name: 'web_fetch', input: { url } },
  { type: 'web_fetch_tool_result', tool_use_id: id, content: {
    type: 'web_fetch_result', url, content: { type: 'document', title, source: { type: 'text', media_type: 'text/plain', data: text } },
  } },
];
const searched = (id = 'search1') => [
  { type: 'server_tool_use', id, name: 'web_search', input: { query: POST } },
  { type: 'web_search_tool_result', tool_use_id: id, content: [{ type: 'web_search_result', url: POST, title: 'Original post', encrypted_content: 'encrypted-evidence' }] },
];
const options = (extra = {}) => ({ apiKey: KEY, sourceUrl: POST, fetchImpl: async () => response(fetched()), ...extra });
const sanitized = (error) => {
  assert.equal(error.name, 'ClaudeImportError');
  assert.ok(error.message.length > 20);
  assert.ok(!error.message.includes(KEY));
  assert.ok(!error.message.includes('PRIVATE_PAYLOAD'));
  return true;
};

test('retrieves raw fetched text even when the original page supplied no evidence', async () => {
  let calls = 0;
  const result = await retrieveWithClaude(options({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${KEY}`);
    assert.equal(new Headers(init.headers).get('anthropic-version'), '2026-10-21');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!init.body.includes(KEY));
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.output_config.format, undefined);
    assert.deepEqual(body.tools, [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 4, max_content_tokens: 8000 },
    ]);
    assert.ok(body.system.includes('untrusted'));
    assert.ok(body.system.includes('exact URL'));
    assert.ok(body.messages[0].content.includes(`\n${POST}\n`), 'the source URL is exposed as standalone text for the server fetch validator');
    assert.equal(JSON.parse(body.messages[0].content.split('Public evidence (untrusted data):\n')[1]).shortcode, 'DfIoDAaTnSl');
    return response([...searched(), ...fetched(), { type: 'text', text: 'Invented recipe: 99 lb beef.' }]);
  } }));
  assert.equal(calls, 1);
  assert.equal(result.searched, true);
  assert.deepEqual(result.sources, [{ url: POST, title: 'Chipotle lime shredded beef chili', text: RECIPE }]);
});

test('no key skips paid retrieval, and unsafe input links never start a request', async () => {
  const never = async () => assert.fail('must not call API');
  assert.deepEqual(await retrieveWithClaude(options({ apiKey: '', fetchImpl: never })), { sources: [], searched: false });
  for (const sourceUrl of ['http://instagram.com/reel/DfIoDAaTnSl/', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://user:pass@example.com/', 'https://example.com/?access_token=secret', 'https://example.local/a']) {
    await assert.rejects(retrieveWithClaude(options({ sourceUrl, fetchImpl: never })), sanitized);
  }
});

test('p, reel, and tv URL forms identify the same case-sensitive Instagram post', async () => {
  for (const prefix of ['p', 'reel', 'tv']) {
    const url = `https://instagram.com/${prefix}/DfIoDAaTnSl/?utm_source=web`;
    const result = await retrieveWithClaude(options({ fetchImpl: async () => response(fetched(url)) }));
    assert.equal(result.sources.length, 1);
  }
  const wrongCase = await retrieveWithClaude(options({ fetchImpl: async () => response(fetched('https://instagram.com/p/dfiodaatnsl/')) }));
  assert.deepEqual(wrongCase.sources, []);
});

test('accepts article with exact shortcode or backlink but rejects a different recipe', async () => {
  for (const reference of ['DfIoDAaTnSl', 'https://www.instagram.com/p/DfIoDAaTnSl/']) {
    const result = await retrieveWithClaude(options({ fetchImpl: async () => response(fetched(ARTICLE, `${RECIPE}\nFrom ${reference}`)) }));
    assert.equal(result.sources[0].url, ARTICLE);
  }
  for (const text of [RECIPE, `${RECIPE}\nDfIoDAaTnSlOTHER`, `${RECIPE}\nhttps://instagram.com/p/OTHER/`]) {
    const result = await retrieveWithClaude(options({ fetchImpl: async () => response(fetched(ARTICLE, text)) }));
    assert.deepEqual(result.sources, []);
  }
});

test('only raw paired server fetch results can become source evidence', async () => {
  const blocks = fetched();
  for (const content of [
    [blocks[1]],
    [{ ...blocks[0], type: 'tool_use' }, blocks[1]],
    [blocks[0], { ...blocks[1], tool_use_id: 'not-the-call' }],
    [blocks[0], { ...blocks[1], content: { ...blocks[1].content, content: { ...blocks[1].content.content, source: { type: 'base64', media_type: 'application/pdf', data: RECIPE } } } }],
    [...searched(), { type: 'text', text: JSON.stringify({ url: POST, title: 'Recipe', text: RECIPE }), citations: [{ cited_text: RECIPE, url: POST }] }],
  ]) {
    const result = await retrieveWithClaude(options({ fetchImpl: async () => response(content) }));
    assert.deepEqual(result.sources, []);
  }
});

test('rejects unsafe fetched URLs even with exact shortcode evidence', async () => {
  for (const url of ['http://recipes.example.com/a', 'https://user:pass@recipes.example.com/a', 'https://recipes.example.com/a?api_key=x', 'https://127.0.0.1/a', 'https://home.internal/a']) {
    const result = await retrieveWithClaude(options({ fetchImpl: async () => response(fetched(url, `${RECIPE}\nDfIoDAaTnSl`)) }));
    assert.deepEqual(result.sources, []);
  }
});

test('accepts an explicit recipe link in supplied or retrieved original caption', async () => {
  const sources = [{ ...evidence[0], text: `${CAPTION}\nRecipe: ${ARTICLE}` }];
  const supplied = await retrieveWithClaude(options({ sources, fetchImpl: async () => response(fetched(ARTICLE)) }));
  assert.equal(supplied.sources[0].url, ARTICLE);
  const retrieved = await retrieveWithClaude(options({ fetchImpl: async () => response([
    ...fetched(ARTICLE, RECIPE, 'article'),
    ...fetched(POST, `${CAPTION}\nRecipe: ${ARTICLE}`, 'post'),
  ]) }));
  assert.ok(retrieved.sources.some((source) => source.url === ARTICLE));
});

test('does not let unrelated supplied sources authorize extra links', async () => {
  const result = await retrieveWithClaude(options({
    sources: [{ url: 'https://recipes.example.com/unrelated', text: `${CAPTION}\nRecipe: ${ARTICLE}` }],
    fetchImpl: async () => response(fetched(ARTICLE)),
  }));
  assert.deepEqual(result.sources, []);
});

test('matches exact caption title on a known creator host and preserves access gates', async () => {
  const text = 'Chipotle lime shredded beef chili\nSubscribe to read this paid recipe. By Caroline Chambers.';
  const result = await retrieveWithClaude(options({
    sources: evidence, relatedUrls: ['https://whattocook.substack.com/'],
    fetchImpl: async () => response(fetched(ARTICLE, text, 'article', 'Chipotle lime shredded beef chili - by Caroline Chambers')),
  }));
  assert.equal(result.sources[0].url, ARTICLE);
  assert.equal(result.sources[0].text, text, 'the importer must see the gate rather than invented recipe details');
});

test('a known creator host alone cannot authorize a different recipe title', async () => {
  for (const title of ['Lime Beef', 'Another shredded beef chili', 'Chipotle lime shredded beef chili with beans']) {
    const result = await retrieveWithClaude(options({
      sources: evidence, relatedUrls: ['https://whattocook.substack.com/'],
      fetchImpl: async () => response(fetched(ARTICLE, RECIPE, 'article', title)),
    }));
    assert.deepEqual(result.sources, []);
  }
});

test('related homepage URLs do not authorize unrelated recipes as exact links', async () => {
  const homepage = 'https://cook.example.com/';
  const result = await retrieveWithClaude(options({
    sources: [{ ...evidence[0], text: 'Lemon Chicken is tonight\'s dinner.' }],
    relatedUrls: [homepage],
    fetchImpl: async () => response(fetched(homepage, 'Brownie Recipe\n2 eggs\n1 cup cocoa\nMix everything.', 'home', 'Brownie Recipe')),
  }));
  assert.deepEqual(result.sources, []);
});

test('a supplied creator profile remains discovery context rather than recipe evidence', async () => {
  const profile = 'https://www.instagram.com/carochambers/';
  const result = await retrieveWithClaude(options({
    sources: [{ ...evidence[0], text: `${CAPTION}\nFollow ${profile}` }],
    relatedUrls: [profile],
    fetchImpl: async () => response(fetched(profile, `${RECIPE}\nDfIoDAaTnSl\nVisit https://whattocook.substack.com/`, 'profile')),
  }));
  assert.deepEqual(result.sources, []);
});

test('title match requires exact related host or matching Instagram creator backlink', async () => {
  const mismatched = await retrieveWithClaude(options({
    sources: evidence, relatedUrls: ['https://other.substack.com/'],
    fetchImpl: async () => response(fetched(ARTICLE)),
  }));
  assert.deepEqual(mismatched.sources, []);
  const creator = await retrieveWithClaude(options({
    sources: evidence,
    fetchImpl: async () => response(fetched(ARTICLE, `${RECIPE}\nFollow https://www.instagram.com/carochambers/`)),
  }));
  assert.equal(creator.sources.length, 1);
  const wrongCreator = await retrieveWithClaude(options({
    sources: evidence,
    fetchImpl: async () => response(fetched(ARTICLE, `${RECIPE}\nFollow https://www.instagram.com/othercreator/`)),
  }));
  assert.deepEqual(wrongCreator.sources, []);
});

test('retrieved known creator profile can establish a matching recipe website', async () => {
  const profile = 'https://www.instagram.com/carochambers/';
  const result = await retrieveWithClaude(options({
    sources: evidence, relatedUrls: [profile],
    fetchImpl: async () => response([
      ...fetched(ARTICLE, RECIPE, 'article', 'Chipotle lime shredded beef chili - by Caroline Chambers'),
      ...fetched(profile, 'Caro Chambers. What to Cook: https://whattocook.substack.com/', 'profile', 'Caro Chambers'),
    ]),
  }));
  assert.ok(result.sources.some((source) => source.url === ARTICLE));
  assert.ok(!result.sources.some((source) => source.url === profile));
  const wrongProfile = await retrieveWithClaude(options({
    sources: evidence,
    fetchImpl: async () => response([
      ...fetched(ARTICLE, RECIPE, 'article'),
      ...fetched('https://instagram.com/anothercook/', 'Visit https://whattocook.substack.com/', 'profile', 'Another Cook'),
    ]),
  }));
  assert.deepEqual(wrongProfile.sources, []);
});

test('official creator About page bridges a blocked Instagram profile to its linked recipe site', async () => {
  const profile = 'https://www.instagram.com/carochambers/';
  const about = 'https://carolinechambers.com/about';
  for (const creatorReference of ['Follow me @carochambers.', `Follow me at ${profile}`]) {
    const result = await retrieveWithClaude(options({
      sources: evidence, relatedUrls: [profile],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.ok(body.messages[0].content.includes(`\n${profile}\n`));
        assert.ok(body.system.includes('full title in quotation marks ALONE'));
        return response([
          ...fetched(ARTICLE, 'Subscribe to read this recipe.', 'article', 'Chipotle lime shredded beef chili - by Caroline Chambers'),
          ...fetched(about, `${creatorReference}\nFind my recipes at https://whattocook.substack.com/`, 'about', 'About Caroline Chambers'),
        ]);
      },
    }));
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, ARTICLE);
    assert.equal(result.sources[0].text, 'Subscribe to read this recipe.');
  }
});

test('creator About bridge requires exact handle and explicit recipe-website link', async () => {
  const about = 'https://carolinechambers.com/about';
  for (const text of [
    'Follow @carochambersplus. Recipes: https://whattocook.substack.com/',
    'Follow @notcarochambers. Recipes: https://whattocook.substack.com/',
    'Follow @carochambers. My recipe newsletter is What to Cook.',
    'By Caroline Chambers. Recipes: https://whattocook.substack.com/',
    'Contact user@carochambers.com. Recipes: https://whattocook.substack.com/',
  ]) {
    const result = await retrieveWithClaude(options({
      sources: evidence,
      fetchImpl: async () => response([
        ...fetched(ARTICLE, RECIPE, 'article'),
        ...fetched(about, text, 'about', 'About Caroline Chambers'),
      ]),
    }));
    assert.deepEqual(result.sources, []);
  }
});

test('another Instagram post is not accepted just because its title matches', async () => {
  const result = await retrieveWithClaude(options({
    sources: evidence, relatedUrls: ['https://www.instagram.com/carochambers/'],
    fetchImpl: async () => response(fetched('https://www.instagram.com/reel/OTHER/')),
  }));
  assert.deepEqual(result.sources, []);
});

test('continues pause_turn once with unchanged server blocks and shared limits', async () => {
  const first = [...searched(), { type: 'thinking', thinking: 'Find original public post', signature: 'signature' }];
  let calls = 0;
  const result = await retrieveWithClaude(options({ fetchImpl: async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (calls === 1) return response(first, 'pause_turn');
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages[1], { role: 'assistant', content: first });
    assert.equal(body.tools[0].max_uses, 3);
    assert.equal(body.tools[1].max_uses, 4);
    return response(fetched(), 'pause_turn');
  } }));
  assert.equal(calls, 2, 'never starts a third paid request');
  assert.equal(result.sources[0].text, RECIPE);
});

test('pairs a server fetch result with a pending call from the paused response', async () => {
  const blocks = fetched();
  let calls = 0;
  const result = await retrieveWithClaude(options({ fetchImpl: async () => ++calls === 1
    ? response([blocks[0]], 'pause_turn') : response([blocks[1]]) }));
  assert.equal(result.sources[0].text, RECIPE);
});

test('verifies an exact-title article after end_turn using a real creator search result and remaining budget', async () => {
  const official = 'https://carolinechambers.com/category/recipes/';
  const first = [
    ...searched('title-search'),
    ...fetched(ARTICLE, 'Subscribe to read this recipe.', 'article', 'Chipotle lime shredded beef chili - by Caroline Chambers'),
    { type: 'server_tool_use', id: 'guessed-about', name: 'web_fetch', input: { url: 'https://whattocook.substack.com/about' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'guessed-about', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_in_prior_context' } },
    { type: 'server_tool_use', id: 'blocked-profile', name: 'web_fetch', input: { url: 'https://instagram.com/carochambers/' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'blocked-profile', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' } },
    { type: 'server_tool_use', id: 'creator-search', name: 'web_search', input: { query: '"@carochambers" official website' } },
    { type: 'web_search_tool_result', tool_use_id: 'creator-search', content: [
      { type: 'web_search_result', url: official, title: 'Recipes - Caroline Chambers', encrypted_content: 'public-encrypted-result' },
    ] },
  ];
  let calls = 0;
  const result = await retrieveWithClaude(options({ sources: evidence, fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) return response(first);
    const body = JSON.parse(init.body);
    assert.equal(body.messages.length, 3);
    assert.deepEqual(body.messages[1], { role: 'assistant', content: first });
    assert.equal(body.messages[2].role, 'user');
    assert.ok(body.messages[2].content.includes(`\n${official}\n`));
    assert.equal(body.tools.find((tool) => tool.name === 'web_search').max_uses, 1);
    assert.equal(body.tools.find((tool) => tool.name === 'web_fetch').max_uses, 1);
    return response(fetched(official, 'Find me @carochambers. Newsletter: https://whattocook.substack.com/', 'official', 'Recipes - Caroline Chambers'));
  } }));
  assert.equal(calls, 2);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, ARTICLE);
  assert.equal(result.sources[0].text, 'Subscribe to read this recipe.');
});

test('verification continuation omits exhausted search tool and never exceeds four fetches', async () => {
  const official = 'https://carolinechambers.com/category/recipes/';
  const creatorSearch = [
    { type: 'server_tool_use', id: 'creator-search', name: 'web_search', input: { query: '"carochambers" official website' } },
    { type: 'web_search_tool_result', tool_use_id: 'creator-search', content: [{ type: 'web_search_result', url: official, title: 'Recipes', encrypted_content: 'encrypted' }] },
  ];
  for (const exhaustedFetches of [false, true]) {
    let calls = 0;
    await retrieveWithClaude(options({ sources: evidence, fetchImpl: async (_url, init) => {
      calls++;
      if (calls === 1) return response([
        ...searched('search1'), ...searched('search2'), ...creatorSearch,
        ...fetched(ARTICLE, RECIPE, 'article'),
        ...(exhaustedFetches ? [0, 1, 2].flatMap((index) => fetched(`https://unrelated.example.com/${index}`, 'Unrelated page', `unrelated${index}`)) : []),
      ]);
      const body = JSON.parse(init.body);
      assert.equal(body.tools.some((tool) => tool.name === 'web_search'), false);
      assert.equal(body.tools[0].name, 'web_fetch');
      assert.equal(body.tools[0].max_uses, 3);
      return response(fetched(official, 'Follow @carochambers. Recipes https://whattocook.substack.com/', 'official', 'Recipes'));
    } }));
    assert.equal(calls, exhaustedFetches ? 1 : 2);
  }
});

test('end_turn without an exact-title article does not spend another request verifying unrelated sources', async () => {
  let calls = 0;
  const result = await retrieveWithClaude(options({ sources: evidence, fetchImpl: async () => {
    calls++;
    return response([
      { type: 'server_tool_use', id: 'creator-search', name: 'web_search', input: { query: '"carochambers" official website' } },
      { type: 'web_search_tool_result', tool_use_id: 'creator-search', content: [{ type: 'web_search_result', url: 'https://carolinechambers.com/category/recipes/', title: 'Recipes' }] },
      ...fetched(ARTICLE, 'Brownies', 'article', 'Chocolate brownies'),
    ]);
  } }));
  assert.equal(calls, 1);
  assert.deepEqual(result.sources, []);
});

test('embedded server tool errors become sanitized actionable failures', async () => {
  for (const tool of ['web_search', 'web_fetch']) {
    for (const error_code of ['too_many_requests', 'url_not_allowed', 'url_not_accessible', 'max_uses_exceeded', 'unavailable', 'invalid_tool_input']) {
      await assert.rejects(retrieveWithClaude(options({ fetchImpl: async () => response([
        { type: 'server_tool_use', id: 'error1', name: tool, input: { url: POST, query: POST } },
        { type: `${tool}_tool_result`, tool_use_id: 'error1', content: { type: `${tool}_tool_result_error`, error_code, message: 'PRIVATE_PAYLOAD' } },
      ]) })), sanitized);
    }
  }
});

test('successful matching evidence is retained when another tool fails', async () => {
  const result = await retrieveWithClaude(options({ fetchImpl: async () => response([
    { type: 'server_tool_use', id: 'search1', name: 'web_search', input: { query: POST } },
    { type: 'web_search_tool_result', tool_use_id: 'search1', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } },
    ...fetched(),
  ]) }));
  assert.equal(result.sources.length, 1);
});

test('HTTP and network failures never expose keys or provider text or retry', async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500, 529, 302]) {
    let calls = 0;
    await assert.rejects(retrieveWithClaude(options({ fetchImpl: async () => {
      calls++;
      return new Response(`${KEY} PRIVATE_PAYLOAD`, { status });
    } })), sanitized);
    assert.equal(calls, 1);
  }
  await assert.rejects(retrieveWithClaude(options({ fetchImpl: async () => { throw new Error(`${KEY} PRIVATE_PAYLOAD`); } })), sanitized);
  await assert.rejects(retrieveWithClaude(options({ fetchImpl: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `${KEY} PRIVATE_PAYLOAD` } })) })), sanitized);
});

test('bounds input, output sources, and response-body size', async () => {
  const sources = [...evidence, ...evidence, ...evidence, { url: POST, title: 'EXCLUDED', text: 'EXCLUDED' }];
  sources[0] = { ...sources[0], text: `${CAPTION}${' '.repeat(6000)}EXCLUDED` };
  const relatedUrls = Array.from({ length: 13 }, (_, i) => `https://related${i}.example.com/`);
  const result = await retrieveWithClaude(options({ sources, relatedUrls, fetchImpl: async (_url, init) => {
    assert.ok(!init.body.includes('EXCLUDED'));
    assert.ok(!init.body.includes('related12.example.com'));
    return response([0, 1, 2, 3].flatMap((index) => fetched(
      `https://recipes.example.com/${index}`, `DfIoDAaTnSl\n${'x'.repeat(22_000)}`, `f${index}`,
    )));
  } }));
  assert.equal(result.sources.length, 3);
  assert.ok(result.sources.every((source) => source.text.length === 20_000));
  await assert.rejects(retrieveWithClaude(options({ fetchImpl: async () => new Response('x'.repeat(513 * 1024)) })), sanitized);
});

test('secret-like values never become prompt text or returned sources', async () => {
  await retrieveWithClaude(options({
    sources: [{ url: POST, title: KEY, text: KEY }, ...evidence],
    relatedUrls: [`https://example.com/${KEY}`],
    fetchImpl: async (_url, init) => {
      assert.ok(!init.body.includes(KEY));
      return response(fetched());
    },
  }));
  let calls = 0;
  await assert.rejects(retrieveWithClaude(options({ fetchImpl: async () => {
    calls++;
    return response(fetched(POST, `${RECIPE} ${KEY}`), 'pause_turn');
  } })), sanitized);
  assert.equal(calls, 1, 'does not echo a provider response containing the key into a continuation');
});

test('total deadline aborts stalled requests and response bodies', { timeout: 2000 }, async () => {
  for (const body of [false, true]) {
    let aborted = false;
    await assert.rejects(retrieveWithClaude(options({ timeoutMs: 20, fetchImpl: async (_url, init) => {
      if (body) return new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')); }, { once: true });
      } }));
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
    } })), sanitized);
    assert.equal(aborted, true);
  }
});

test('a response arriving after the deadline cannot trigger a continuation', { timeout: 2000 }, async () => {
  let calls = 0;
  let release;
  const pending = retrieveWithClaude(options({ timeoutMs: 10, fetchImpl: async () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  } }));
  await assert.rejects(pending, sanitized);
  release(response(searched(), 'pause_turn'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
});

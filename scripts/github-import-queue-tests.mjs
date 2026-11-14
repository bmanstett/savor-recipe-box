import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Compile the actual browser boundary without loading the DOM or changing its
// module imports. Its dependencies are type-only, so the result is standalone.
const source = await readFile(new URL('../lib/github-import-queue.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { queueGitHubRecipeImport, GitHubImportError } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const sourceUrl = 'https://recipes.example/lemon-pasta';
const connection = {
  owner: 'test-kitchen', repo: 'savor-data', branch: 'main', filePath: 'savor/v1/state.json',
  username: 'test-kitchen', connectedAt: '2026-11-14T12:00:00.000Z', lastSyncAt: null,
};
const draft = {
  id: 'recipe_test', title: 'Lemon Pasta', description: '', heroImage: null, sourceType: 'url',
  sourceURL: sourceUrl, sourceName: 'recipes.example', author: null, servings: 2,
  prepTime: null, cookTime: null, totalTime: null, cuisine: null, categories: [], tags: [],
  ingredients: [{
    id: 'ingredient_test', rawText: '200 g pasta', quantity: { numerator: 200, denominator: 1 },
    unit: 'g', normalizedUnit: 'g', ingredientName: 'pasta', normalizedIngredient: 'pasta',
    descriptor: null, preparation: null, groceryCategory: 'Pasta, Rice & Grains',
    optional: false, section: null, confidence: 0.9, needsReview: false,
  }],
  instructions: [{ id: 'step_test', stepNumber: 1, section: null, text: 'Boil the pasta, then toss with lemon.', timerMinutes: null }],
  rating: null, favorite: false, notes: '', attachments: [],
};

function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

async function importResult(patch = {}) {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const requests = [];
  const progress = [];
  let queued;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com', 'the client must send requests only to GitHub');
    requests.push({ url: url.href, method: init.method ?? 'GET' });
    if (init.method === 'DELETE') return json({});
    if (url.pathname.endsWith('/.github/workflows/savor-recipe-import.yml')) return json({ type: 'file' });
    if (init.method === 'PUT') {
      const payload = JSON.parse(init.body);
      queued = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
      assert.deepEqual(Object.keys(queued).sort(), ['createdAt', 'jobId', 'url', 'version']);
      assert.equal(queued.url, sourceUrl);
      assert.equal(payload.branch, 'main');
      return json({ content: { sha: 'request-sha' } });
    }
    assert(queued, 'a result is read only after the request is queued');
    assert(url.pathname.endsWith(`/results/${queued.jobId}.json`));
    const result = {
      version: 1, jobId: queued.jobId, status: 'success', importerVersion: '5',
      provider: 'claude', draft, warnings: [], completedAt: '2026-11-14T12:00:00.000Z',
      sourcesChecked: [{ kind: 'recipe-page', url: sourceUrl, label: 'Recipe page' }],
      ...patch,
    };
    return json({ type: 'file', sha: 'result-sha', content: Buffer.from(JSON.stringify(result)).toString('base64') });
  };
  try {
    const result = await queueGitHubRecipeImport(connection, 'test-github-token', `${sourceUrl}?utm_source=test`, {
      onProgress: (stage) => progress.push(stage),
    });
    // Cleanup is intentionally best-effort and asynchronous in the client.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(progress, ['queued', 'reading', 'structuring']);
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 2);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
}

const accepted = await importResult();
assert.equal(accepted.provider, 'claude');
assert.equal(accepted.draft.title, 'Lemon Pasta');
assert.equal(accepted.draft.ingredients[0].rawText, '200 g pasta');
assert.equal(accepted.importerVersion, '5');
assert.deepEqual(accepted.warnings, []);

const partial = await importResult({ status: 'partial', warnings: ['Some steps need review.'] });
assert.equal(partial.provider, 'claude');
assert.deepEqual(partial.warnings, ['Some steps need review.']);

const older = await importResult({ provider: 'schema-org', importerVersion: '4' });
assert.equal(older.provider, 'schema-org');
assert(older.warnings.some((warning) => warning.includes('expects 5') && warning.includes('Claude public recipe search')));

await assert.rejects(importResult({ provider: 'unknown-provider' }), GitHubImportError);
await assert.rejects(importResult({ jobId: 'another-job' }), /invalid recipe-import result/);
await assert.rejects(importResult({ draft: { ...draft, ingredients: [{ rawText: '200 g pasta' }] } }), /unsupported format/);
await assert.rejects(importResult({
  sourcesChecked: [{ kind: 'recipe-page', url: 'https://other.example/unrelated', label: 'Other page' }],
}), /different source link/);
await assert.rejects(importResult({ status: 'error', error: 'Claude is temporarily unavailable. Paste the recipe text instead.' }), /Claude is temporarily unavailable/);

const foundPage = { kind: 'recipe-page', url: 'https://creator.example/recipes/lemon-pasta', label: 'Recipe found: Lemon Pasta' };
await assert.rejects(importResult({
  status: 'error', error: 'Claude found the recipe, but the creator’s page requires sign-in or a subscription.',
  sourcesChecked: [{ kind: 'recipe-page', url: sourceUrl, label: 'Original recipe link' }, foundPage],
}), (error) => {
  assert(error instanceof GitHubImportError);
  assert.match(error.message, /requires sign-in/);
  assert.deepEqual(error.sourcesChecked[1], foundPage);
  return true;
});
await assert.rejects(importResult({ status: 'error', error: 'Old importer error', sourcesChecked: undefined }), (error) => {
  assert.equal(error.message, 'Old importer error');
  assert.deepEqual(error.sourcesChecked, []);
  return true;
});
await assert.rejects(importResult({ status: 'error', sourcesChecked: [foundPage] }), /different source link/);
await assert.rejects(importResult({ status: 'error', sourcesChecked: [{ ...foundPage, url: 'javascript:alert(1)' }] }), /invalid recipe source details/);
await assert.rejects(importResult({ status: 'error', sourcesChecked: Array(21).fill(foundPage) }), /invalid recipe source details/);

console.log('GitHub import queue tests passed (Claude review drafts, partial results, older importers, validation, and source matching).');

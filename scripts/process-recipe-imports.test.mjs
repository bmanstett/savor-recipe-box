import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractRecipeJsonLd,
  isPublicIpAddress,
  parseInstagramReaderPayload,
  parseRecipeCaption,
  processImportRequest,
  rankRelatedUrls,
  validateUrlSyntax,
} from './process-recipe-imports.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(directory, 'fixtures');
const readFixture = (name) => fs.readFile(path.join(fixtures, name), 'utf8');

const html = await readFixture('recipe-page.html');
const recipes = extractRecipeJsonLd(html);
assert.equal(recipes.length, 1);
assert.equal(recipes[0].name, 'Lemony Sheet-Pan Chicken');

const readerJson = await readFixture('instagram-reader.json');
const reader = parseInstagramReaderPayload(readerJson, 'https://www.instagram.com/reel/ABC123/');
assert.equal(reader.creator, 'avery.kitchen');
assert.match(reader.caption, /Easy Tomato Pasta/);
assert.deepEqual(reader.relatedUrls.map((url) => url.href), ['https://recipes.example.com/tomato-pasta']);

const truncatedReaderPayload = JSON.parse(readerJson);
truncatedReaderPayload.data.metadata['og:description'] = 'avery.kitchen on August 23, 2026: “Easy Tomato Pasta. Ingredients in caption…”';
truncatedReaderPayload.data.description = truncatedReaderPayload.data.metadata['og:description'];
truncatedReaderPayload.data.content = `[avery.kitchen](https://www.instagram.com/avery.kitchen/) • 2d\n\n${reader.caption}\n\n[another.user](https://www.instagram.com/another.user/) Looks delicious!`;
const recoveredReader = parseInstagramReaderPayload(truncatedReaderPayload, 'https://www.instagram.com/reel/ABC123/');
assert.match(recoveredReader.caption, /12 oz spaghetti/, 'full reader markdown should beat truncated Open Graph text');

const captionDraft = parseRecipeCaption(reader.caption, {
  sourceURL: 'https://www.instagram.com/reel/ABC123/',
  sourceName: 'Instagram',
  author: '@avery.kitchen',
  heroImage: reader.heroImage,
});
assert.equal(captionDraft.title, 'Easy Tomato Pasta');
assert.equal(captionDraft.servings, 4);
assert.equal(captionDraft.ingredients.length, 5);
assert.equal(captionDraft.instructions.length, 4);
assert.equal(captionDraft.author, '@avery.kitchen');

const emojiCaption = parseRecipeCaption(`Crispy Potatoes\nINGREDIENTS 👇\n• 2 lb potatoes\n• 2 tbsp olive oil\nINSTRUCTIONS ⬇️\n1️⃣ Heat the oven.\n2️⃣ Roast until crisp.`, {
  sourceURL: 'https://www.instagram.com/reel/EMOJI1/', sourceName: 'Instagram',
});
assert.equal(emojiCaption.ingredients.length, 2);
assert.equal(emojiCaption.instructions.length, 2);

const narrativeCaption = parseRecipeCaption(`Y’all debated about this, some even got mad at me lol.\nThe full recipe is finally here.\nMAC N CHEESE LASAGNA\nIngredients:\n1 lb pasta\nInstructions:\n1. Bake until bubbling.`, {
  sourceURL: 'https://www.instagram.com/reel/TITLE1/', sourceName: 'Instagram',
});
assert.equal(narrativeCaption.title, 'MAC N CHEESE LASAGNA', 'a title-like line before Ingredients should beat social caption preamble');

const slashTitleCaption = parseRecipeCaption(`Y’all debated about this.\nMac’n’cheese lasagna/Beefaroni/Hamburger Helper\nIngredients:\n1 lb pasta\nInstructions:\n1. Bake until bubbling.`, {
  sourceURL: 'https://www.instagram.com/reel/TITLE2/', sourceName: 'Instagram',
});
assert.equal(slashTitleCaption.title, 'Mac’n’cheese lasagna');

const request = JSON.parse(await readFixture('request-instagram.json'));
let mockCalls = 0;
const captionResult = await processImportRequest(request, {
  now: () => '2026-08-23T17:00:00.000Z',
  fetchText: async (url) => {
    mockCalls += 1;
    assert.equal(new URL(url).hostname, 'r.jina.ai');
    return { status: 200, headers: {}, body: readerJson, url: new URL(url) };
  },
});
assert.equal(mockCalls, 1, 'a complete caption recipe should not trigger unrelated crawling');
assert.equal(captionResult.version, 1);
assert.equal(captionResult.status, 'success');
assert.equal(captionResult.provider, 'instagram-caption');
assert.equal(captionResult.jobId, request.jobId);
assert.equal(captionResult.draft.sourceURL, 'https://www.instagram.com/reel/ABC123/');
assert.equal(captionResult.draft.heroImage, null);
assert.equal(captionResult.sourcesChecked.length, 1);
assert.match(captionResult.warnings[0], /did not transcribe/i);

const linkedReaderJson = await readFixture('instagram-reader-linked.json');
const profileReaderJson = await readFixture('instagram-profile-reader.json');
const profileReaderPayload = JSON.parse(profileReaderJson);
profileReaderPayload.data.description = 'Weeknight recipes and meal prep ideas.';
profileReaderPayload.data.metadata['og:description'] = profileReaderPayload.data.description;
profileReaderPayload.data.content = '[Avery Kitchen](https://www.instagram.com/avery.kitchen/)\nWeeknight recipes and meal prep ideas\nhttps://recipes.example.com/lemon-chicken';
const profileReader = parseInstagramReaderPayload(profileReaderPayload, 'https://www.instagram.com/avery.kitchen/');
assert.deepEqual(profileReader.relatedUrls.map((url) => url.href), ['https://recipes.example.com/lemon-chicken']);
const linkedRequest = { ...request, jobId: 'fixture-job-002' };
const linkedResult = await processImportRequest(linkedRequest, {
  now: () => '2026-08-23T17:01:00.000Z',
  fetchText: async (urlValue) => {
    const url = new URL(urlValue);
    if (url.hostname === 'r.jina.ai' && url.pathname.includes('/https://www.instagram.com/reel/')) {
      return { status: 200, headers: {}, body: linkedReaderJson, url };
    }
    if (url.hostname === 'r.jina.ai' && url.pathname.includes('/https://www.instagram.com/avery.kitchen/')) {
      return { status: 200, headers: {}, body: profileReaderJson, url };
    }
    if (url.href === 'https://recipes.example.com/lemon-chicken') {
      return { status: 200, headers: { 'content-type': 'text/html' }, body: html, url };
    }
    throw new Error(`Unexpected mocked URL: ${url.href}`);
  },
});
assert.equal(linkedResult.status, 'success');
assert.equal(linkedResult.provider, 'linked-recipe');
assert.equal(linkedResult.draft.title, 'Lemony Sheet-Pan Chicken');
assert.equal(linkedResult.draft.sourceURL, 'https://www.instagram.com/reel/ABC123/');
assert.equal(linkedResult.draft.notes, 'Recipe details: https://recipes.example.com/lemon-chicken');
assert.deepEqual(linkedResult.sourcesChecked.map((source) => source.kind), ['instagram-post', 'creator-profile', 'recipe-page']);

const rankedUrls = rankRelatedUrls([
  new URL('https://avery.example.com/about'),
  new URL('https://linktr.ee/avery.kitchen'),
  new URL('https://avery.example.com/lemony-sheet-pan-chicken'),
], ['lemony', 'sheet', 'pan', 'chicken']);
assert.deepEqual(rankedUrls.map((url) => url.href), [
  'https://avery.example.com/lemony-sheet-pan-chicken',
  'https://linktr.ee/avery.kitchen',
  'https://avery.example.com/about',
], 'title-matching slugs should outrank hubs, and hubs should outrank non-recipe pages');

const hubReaderJson = await readFixture('instagram-reader-hub.json');
const hubProfileJson = await readFixture('instagram-profile-hub.json');
const hubHtml = await readFixture('link-hub-page.html');
const hubRequest = { ...request, jobId: 'fixture-job-003', url: 'https://www.instagram.com/reel/HUB123/' };
const hubFetches = [];
const hubResult = await processImportRequest(hubRequest, {
  now: () => '2026-08-23T17:02:00.000Z',
  fetchText: async (urlValue) => {
    const url = new URL(urlValue);
    hubFetches.push(url.href);
    if (url.hostname === 'r.jina.ai' && url.pathname.includes('/reel/HUB123')) {
      return { status: 200, headers: {}, body: hubReaderJson, url };
    }
    if (url.hostname === 'r.jina.ai' && url.pathname.includes('/https://www.instagram.com/avery.kitchen/')) {
      return { status: 200, headers: {}, body: hubProfileJson, url };
    }
    if (url.href === 'https://linktr.ee/avery.kitchen') {
      return { status: 200, headers: { 'content-type': 'text/html' }, body: hubHtml, url };
    }
    if (url.href === 'https://avery.example.com/lemony-sheet-pan-chicken') {
      return { status: 200, headers: { 'content-type': 'text/html' }, body: html, url };
    }
    throw new Error(`Unexpected mocked URL: ${url.href}`);
  },
});
assert.equal(hubResult.status, 'success');
assert.equal(hubResult.provider, 'linked-recipe');
assert.equal(hubResult.draft.title, 'Lemony Sheet-Pan Chicken');
assert.equal(hubResult.draft.sourceURL, 'https://www.instagram.com/reel/HUB123/');
assert.equal(hubResult.draft.notes, 'Recipe details: https://avery.example.com/lemony-sheet-pan-chicken');
assert.deepEqual(hubResult.sourcesChecked.map((source) => source.kind), ['instagram-post', 'creator-profile', 'recipe-page', 'recipe-page']);
assert.equal(hubResult.sourcesChecked[2].label, 'Creator links on linktr.ee');
assert.equal(hubFetches.length, 4, 'ranking should reach the linked recipe without visiting about/shop pages');

for (const unsafe of [
  'http://example.com/recipe',
  'https://localhost/recipe',
  'https://127.0.0.1/recipe',
  'https://10.0.0.1/recipe',
  'https://[::1]/recipe',
  'https://user:password@example.com/recipe',
  'https://example.com:8443/recipe',
]) {
  assert.throws(() => validateUrlSyntax(unsafe), unsafe);
}
assert.equal(validateUrlSyntax('https://example.com/recipe').href, 'https://example.com/recipe');
assert.equal(isPublicIpAddress('8.8.8.8'), true);
assert.equal(isPublicIpAddress('192.168.1.1'), false);
assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
assert.equal(isPublicIpAddress('fc00::1'), false);

console.log('Recipe import processor fixture tests passed.');

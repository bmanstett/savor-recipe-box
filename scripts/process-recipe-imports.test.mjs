import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  BROWSER_USER_AGENT,
  DEFAULT_MAX_RUN_MS,
  HONEST_USER_AGENT,
  IMPORTER_VERSION,
  INSECURE_PAGE_MESSAGE,
  MAX_HERO_IMAGE_BYTES,
  MAX_RESPONSE_BYTES,
  READER_MAX_RESPONSE_BYTES,
  clampDraftToClientLimits,
  decodeBodyText,
  decodeResponseBodyLenient,
  draftFromSchemaRecipe,
  extractRecipeFromHtml,
  extractRecipeJsonLd,
  fetchWithFallbacks,
  htmlToText,
  instagramShortcode,
  isPublicIpAddress,
  looksLikeBotChallenge,
  normalizeSourceUrl,
  parseArguments,
  parseIngredient,
  parseInstagramEmbed,
  parseInstagramReaderPayload,
  parseRecipeCaption,
  pickRecipeTitle,
  processImportRequest,
  processPendingRequests,
  rankRelatedUrls,
  sniffImageType,
  validateUrlSyntax,
} from './process-recipe-imports.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(directory, 'fixtures');
const readFixture = (name) => fs.readFile(path.join(fixtures, name), 'utf8');
const readFixtureBytes = (name) => fs.readFile(path.join(fixtures, name));
const page = (body, url) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, url: new URL(url) });
const NOW = () => '2026-08-23T17:00:00.000Z';
const PAYWALL_MESSAGE = 'This page keeps its recipe behind a sign-in. Open it in your browser, copy the recipe text, and paste it into Savor.';
const GROCERY_CATEGORIES = new Set(['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry', 'Canned & Jarred', 'Pasta, Rice & Grains', 'Spices & Seasonings', 'Sauces & Condiments', 'Other']);

/** Mirror of lib/github-import-queue.ts isIngredient so importer output always validates in the app. */
function assertClientIngredient(value) {
  const nullableString = (item, max) => item === null || (typeof item === 'string' && item.length <= max);
  const rationalOk = (item) => item === null || (item && Number.isFinite(item.numerator) && Number.isFinite(item.denominator) && item.denominator !== 0);
  assert.ok(typeof value.id === 'string' && value.id.length <= 200, 'id');
  assert.ok(typeof value.rawText === 'string' && value.rawText.length <= 2_000, 'rawText');
  assert.ok(rationalOk(value.quantity), 'quantity');
  assert.ok(nullableString(value.unit, 100) && nullableString(value.normalizedUnit, 100), 'unit');
  assert.ok(typeof value.ingredientName === 'string' && typeof value.normalizedIngredient === 'string', 'names');
  assert.ok(nullableString(value.descriptor, 500) && nullableString(value.preparation, 500), 'descriptor/preparation');
  assert.ok(GROCERY_CATEGORIES.has(value.groceryCategory), `category ${value.groceryCategory}`);
  assert.equal(typeof value.optional, 'boolean');
  assert.ok(nullableString(value.section, 500), 'section');
  assert.ok(value.confidence >= 0 && value.confidence <= 1, 'confidence');
  assert.equal(typeof value.needsReview, 'boolean');
}

function assertValidDraft(draft) {
  assert.ok(draft.title, 'draft title');
  for (const ingredient of draft.ingredients) assertClientIngredient(ingredient);
  draft.instructions.forEach((step, index) => {
    assert.equal(step.stepNumber, index + 1);
    assert.ok(step.text && typeof step.text === 'string');
  });
}

/** Mirror of lib/github-import-queue.ts parseQueueResult: the link the app sent must be among the sources checked. */
function assertClientSourceContract(result, sentUrl) {
  const sourcesChecked = result.sourcesChecked ?? [];
  const knownUrls = new Set([sentUrl, ...sourcesChecked.map((source) => source.url), ...(result.draft?.sourceLinks ?? []).map((link) => link.url)]);
  assert.ok(sourcesChecked.some((source) => source.url === sentUrl), `sourcesChecked must contain the URL as sent: ${sentUrl}`);
  if (result.draft?.sourceURL) assert.ok(knownUrls.has(result.draft.sourceURL), `draft.sourceURL ${result.draft.sourceURL} must be a URL the app knows`);
  assert.ok(sourcesChecked.length <= 20, 'the app rejects more than 20 checked sources');
}

function mockFetch(routes) {
  const calls = [];
  const fetchText = async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    calls.push({ href: url.href, profile: options.profile ?? 'ladder' });
    for (const [matcher, handler] of routes) {
      if (typeof matcher === 'string' ? url.href === matcher : matcher.test(url.href)) return handler(url, options);
    }
    throw new Error(`Unexpected mocked URL: ${url.href}`);
  };
  return { calls, fetchText };
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

const html = await readFixture('recipe-page.html');
assert.equal(extractRecipeJsonLd(html).length, 1);
assert.equal(extractRecipeJsonLd(html)[0].name, 'Lemony Sheet-Pan Chicken');

const exampleUrl = new URL('https://recipes.example.com/post');
const hardened = draftFromSchemaRecipe({
  '@type': 'Recipe',
  name: ['Harden &amp; Test'],
  image: [{ '@type': 'ImageObject', contentUrl: 'https://images.example.com/a.jpg' }],
  author: [{ '@type': 'Person', name: 'Ada' }, { '@type': 'Person', name: 'Bo' }],
  recipeYield: ['4 to 6 servings', '4'],
  keywords: ['one', 'two'],
  prepTime: 'P0DT0H30M',
  cookTime: 'PT1H',
  recipeIngredient: ['2 cups &frac12; <b>flour</b>', '1 egg'],
  recipeInstructions: [
    { '@type': 'HowToSection', name: 'Dough', itemListElement: [{ '@type': 'HowToStep', name: 'Mix the dough.', text: 'Mix the dough.' }] },
    { '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', position: 2, item: { '@type': 'HowToStep', text: 'Rest for 30 minutes.' } }] },
    { '@type': 'HowToDirection', text: 'Roll out thinly.' },
    { '@type': 'HowToTip', text: 'A warm kitchen helps.' },
    'Mix the dough.',
  ],
}, exampleUrl);
assert.equal(hardened.title, 'Harden & Test');
assert.equal(hardened.heroImage, 'https://images.example.com/a.jpg');
assert.equal(hardened.author, 'Ada & Bo', 'two authors are joined with an ampersand');
assert.equal(hardened.servings, 4);
assert.deepEqual(hardened.tags, ['one', 'two']);
assert.equal(hardened.prepTime, 30);
assert.equal(hardened.cookTime, 60);
assert.equal(hardened.totalTime, 90);
assert.equal(hardened.ingredients[0].rawText, '2 cups ½ flour');
assert.deepEqual(hardened.instructions.map((step) => step.text), ['Mix the dough.', 'Rest for 30 minutes.', 'Roll out thinly. Tip: A warm kitchen helps.'], 'a HowToTip is appended to the step before it');
assert.equal(hardened.instructions[0].section, 'Dough');

const htmlSteps = draftFromSchemaRecipe({ '@type': 'Recipe', name: 'HTML steps', recipeInstructions: '<ol><li>First step.</li><li>Second step.</li></ol>' }, exampleUrl);
assert.deepEqual(htmlSteps.instructions.map((step) => step.text), ['First step.', 'Second step.']);
const paragraphSteps = draftFromSchemaRecipe({ '@type': 'Recipe', name: 'P steps', recipeInstructions: '<p>Chop.</p><p>Cook.</p>' }, exampleUrl);
assert.deepEqual(paragraphSteps.instructions.map((step) => step.text), ['Chop.', 'Cook.']);

const nestedHtml = `<html><head><!-- <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","mainEntity":{"@type":"Recipe","name":"Commented Recipe","recipeIngredient":["1 cup rice"],"recipeInstructions":[{"@type":"HowToStep","text":"Cook the rice."}]}};</script> --></head><body></body></html>`;
assert.equal(extractRecipeJsonLd(nestedHtml)[0].name, 'Commented Recipe', 'JSON-LD inside an HTML comment with a trailing semicolon and mainEntity nesting');

const multiRecipeHtml = `<html><head>
<script type="application/ld+json">{"@type":"Recipe","name":"Teaser Only"}</script>
<script type='application/ld+json'>{"@graph":[{"@type":"https://schema.org/Recipe","name":"Full Recipe","recipeIngredient":["1 egg","2 cups milk"],"recipeInstructions":[{"@type":"HowToStep","text":"Whisk."},{"@type":"HowToStep","text":"Cook."}]}]}</script>
</head><body></body></html>`;
assert.equal(extractRecipeFromHtml(multiRecipeHtml, exampleUrl).chosen.draft.title, 'Full Recipe', 'the best-scoring Recipe node wins');

// NYT-shaped page: @graph, isAccessibleForFree:false, ImageObject contentUrl, Person author, HowToSteps.
const nytHtml = await readFixture('recipe-nyt-shaped.html');
const nytMock = mockFetch([[/cooking\.example\.com/, (url) => page(nytHtml, url.href)]]);
const nytResult = await processImportRequest({
  version: 1, jobId: 'nyt-001', createdAt: NOW(),
  url: 'https://cooking.example.com/recipes/1024345-fixture-green-chicken-chili?smid=ck-recipe-iOS-share&sgrp=c-cb',
}, { now: NOW, fetchText: nytMock.fetchText });
assert.equal(nytResult.status, 'success');
assert.equal(nytResult.provider, 'schema-org');
assert.equal(nytResult.version, 1);
assert.equal(nytResult.importerVersion, IMPORTER_VERSION);
assert.equal(nytResult.draft.title, 'Fixture Green Chicken Chili');
assert.equal(nytResult.draft.sourceURL, 'https://cooking.example.com/recipes/1024345-fixture-green-chicken-chili', 'share tracking parameters are stripped');
assert.equal(nytResult.draft.author, 'Fixture Author');
assert.equal(nytResult.draft.servings, 4);
assert.equal(nytResult.draft.prepTime, 10);
assert.equal(nytResult.draft.cookTime, 40);
assert.equal(nytResult.draft.totalTime, 50);
assert.equal(nytResult.draft.heroImage, 'https://static.example.com/images/chili-16x9.jpg');
assert.equal(nytResult.draft.ingredients.length, 17);
assert.equal(nytResult.draft.instructions.length, 4);
assert.deepEqual(nytResult.draft.categories, ['dinner', 'soups and stews', 'main course']);
assertValidDraft(nytResult.draft);
assert.equal(nytMock.calls.length, 1);
const nytSentUrl = 'https://cooking.example.com/recipes/1024345-fixture-green-chicken-chili?smid=ck-recipe-iOS-share&sgrp=c-cb';
assert.deepEqual(nytResult.sourcesChecked.map((source) => [source.kind, source.url]), [
  ['recipe-page', nytSentUrl],
  ['recipe-page', 'https://cooking.example.com/recipes/1024345-fixture-green-chicken-chili'],
], 'the link as sent is recorded alongside the canonical one');
assertClientSourceContract(nytResult, nytSentUrl);

// Links carrying parameters the app does not strip itself must still satisfy its source check.
const refUrl = 'https://recipes.example.com/post?ref=newsletter';
const refResult = await processImportRequest({ version: 1, jobId: 'ref-001', createdAt: NOW(), url: refUrl }, { now: NOW, fetchText: async (url) => page(html, url) });
assert.equal(refResult.status, 'success');
assert.equal(refResult.draft.sourceURL, 'https://recipes.example.com/post');
assert.deepEqual(refResult.sourcesChecked.map((source) => source.url), [refUrl, 'https://recipes.example.com/post']);
assertClientSourceContract(refResult, refUrl);

// A redirect (trailing slash, moved page): the draft keeps the requested URL; the final URL is a source checked and a source link.
const movedResult = await processImportRequest({ version: 1, jobId: 'moved-001', createdAt: NOW(), url: 'https://recipes.example.com/post' }, {
  now: NOW, fetchText: async () => page(html, 'https://recipes.example.com/post/'),
});
assert.equal(movedResult.status, 'success');
assert.equal(movedResult.draft.sourceURL, 'https://recipes.example.com/post', 'the requested URL stays the source');
assert.deepEqual(movedResult.sourcesChecked.map((source) => source.url), ['https://recipes.example.com/post', 'https://recipes.example.com/post/']);
assert.deepEqual(movedResult.draft.sourceLinks, [{ kind: 'recipe-page', url: 'https://recipes.example.com/post/', label: 'Recipe page on recipes.example.com' }]);
assertClientSourceContract(movedResult, 'https://recipes.example.com/post');
assert.equal(nytResult.draft.sourceLinks, undefined, 'no redirect, no source link');

const paywallHtml = await readFixture('recipe-paywalled.html');
const paywallResult = await processImportRequest({ version: 1, jobId: 'paywall-001', createdAt: NOW(), url: 'https://cooking.example.com/recipes/2-short-ribs' }, {
  now: NOW, fetchText: async (url) => page(paywallHtml, url),
});
assert.equal(paywallResult.status, 'error');
assert.equal(paywallResult.error, PAYWALL_MESSAGE);
assert.equal(paywallResult.importerVersion, IMPORTER_VERSION);

// ---------------------------------------------------------------------------
// Microdata and recipe-card plugins
// ---------------------------------------------------------------------------

const microdataResult = await processImportRequest({ version: 1, jobId: 'micro-001', createdAt: NOW(), url: 'https://fixture.wiki/recipes/carrot-salad' }, {
  now: NOW, fetchText: async (url) => page(await readFixture('recipe-microdata.html'), url),
});
assert.equal(microdataResult.status, 'success');
assert.equal(microdataResult.provider, 'microdata');
assert.equal(microdataResult.draft.title, 'Shaved Carrot Ribbon Salad');
assert.equal(microdataResult.draft.ingredients.length, 5);
assert.equal(microdataResult.draft.ingredients[1].rawText, 'Big handful cilantro, chopped');
assert.equal(microdataResult.draft.instructions.length, 3);
assert.equal(microdataResult.draft.servings, 4);
assert.equal(microdataResult.draft.prepTime, 15);
assert.equal(microdataResult.draft.totalTime, 20);
assert.equal(microdataResult.draft.author, 'Fixture Cook');
assert.equal(microdataResult.draft.heroImage, 'https://fixture.wiki/images/carrot-salad.jpg');
assertValidDraft(microdataResult.draft);

const wprmResult = await processImportRequest({ version: 1, jobId: 'wprm-001', createdAt: NOW(), url: 'https://blog.example.com/crispy-smashed-potatoes/' }, {
  now: NOW, fetchText: async (url) => page(await readFixture('recipe-wprm.html'), url),
});
assert.equal(wprmResult.status, 'success');
assert.equal(wprmResult.provider, 'text-parser');
assert.equal(wprmResult.draft.title, 'Crispy Smashed Potatoes');
assert.deepEqual(wprmResult.draft.ingredients.map((item) => item.section), ['Potatoes', 'Potatoes', 'Garlic butter', 'Garlic butter']);
assert.equal(wprmResult.draft.ingredients[0].rawText, '2 lb baby potatoes');
assert.equal(wprmResult.draft.instructions.length, 3);
assert.equal(wprmResult.draft.servings, 4);
assert.equal(wprmResult.draft.prepTime, 10);
assert.equal(wprmResult.draft.cookTime, 45);
assertValidDraft(wprmResult.draft);

const tastyResult = await processImportRequest({ version: 1, jobId: 'tasty-001', createdAt: NOW(), url: 'https://table.example.com/lemon-orzo/' }, {
  now: NOW, fetchText: async (url) => page(await readFixture('recipe-tasty.html'), url),
});
assert.equal(tastyResult.status, 'success');
assert.equal(tastyResult.draft.title, 'Weeknight Lemon Orzo');
assert.equal(tastyResult.draft.ingredients.length, 4);
assert.equal(tastyResult.draft.instructions.length, 3);
assert.equal(tastyResult.draft.servings, 4);

const mediavineResult = await processImportRequest({ version: 1, jobId: 'mv-001', createdAt: NOW(), url: 'https://pantry.example.com/maple-pecan-granola/' }, {
  now: NOW, fetchText: async (url) => page(await readFixture('recipe-mediavine.html'), url),
});
assert.equal(mediavineResult.status, 'success');
assert.equal(mediavineResult.draft.title, 'Maple Pecan Granola');
assert.equal(mediavineResult.draft.ingredients.length, 4);
assert.equal(mediavineResult.draft.instructions.length, 3);
assert.equal(mediavineResult.draft.servings, 8);

// WPRM print view is tried only when WPRM markup exists but ingredients are missing.
const wprmShell = '<html><head><title>Crispy Smashed Potatoes | Fixture Blog</title></head><body><h2 class="wprm-recipe-name">Crispy Smashed Potatoes</h2><p>Ingredients load lazily.</p></body></html>';
const printMock = mockFetch([
  ['https://blog.example.com/crispy-smashed-potatoes/', (url) => page(wprmShell, url.href)],
  ['https://blog.example.com/wprm_print/crispy-smashed-potatoes', async (url) => page(await readFixture('recipe-wprm.html'), url.href)],
]);
const printResult = await processImportRequest({ version: 1, jobId: 'wprm-002', createdAt: NOW(), url: 'https://blog.example.com/crispy-smashed-potatoes/' }, { now: NOW, fetchText: printMock.fetchText });
assert.equal(printResult.status, 'success');
assert.deepEqual(printMock.calls.map((call) => call.href), ['https://blog.example.com/crispy-smashed-potatoes/', 'https://blog.example.com/wprm_print/crispy-smashed-potatoes']);

// ---------------------------------------------------------------------------
// Visible text and titles
// ---------------------------------------------------------------------------

const leakHtml = '<html><head><meta content="a > b" name="description"><title>Leak Test</title></head><body><nav><a href="/">Home</a></nav><noscript><img src="x?&noscript=1"></noscript><main><h1>Soup &amp; Bread</h1><ol><li>one</li><li>two</li></ol><ul><li>bullet</li></ul><p>a<br>b</p><div aria-hidden="true">hidden</div><footer>foot</footer></main></body></html>';
const leakText = htmlToText(leakHtml);
assert.ok(!leakText.includes('> b') && !leakText.includes('noscript') && !leakText.includes('Home') && !leakText.includes('hidden') && !leakText.includes('foot'), leakText);
assert.deepEqual(leakText.split('\n'), ['Soup & Bread', '1. one', '2. two', '• bullet', 'a', 'b'], 'the <head> (title, meta) is not visible text');
assert.equal(htmlToText('<html><head><title>No closing head</title><body><p>Body text</p></body></html>'), 'Body text', 'an omitted </head> ends at <body>');
assert.equal(htmlToText('<body class="category-cookies"><div class="entry"><p>Dough</p></div><div class="comments-area"><p>Comment</p></div><section id="related-posts"><p>Related</p></section><div class="sidebar-widget">Side</div><div class="newsletter-signup">Join</div><div class="cookie-notice">Cookies</div><div class="advert">Ad</div></body>'), 'Dough', 'comment, related, sidebar, newsletter, cookie and advert containers are dropped, but a body classed by category is not');
assert.equal(htmlToText('<body><div id="post-1" class="post-1 post type-post hentry tag-cookies"><h1>Chocolate Chip Cookies</h1><p>1 cup flour</p></div></body>'), 'Chocolate Chip Cookies\n1 cup flour', 'a WordPress post wrapper tagged "cookies" is content');
assert.equal(htmlToText('<body><section class="post tag-cookies"><p>1 cup flour</p></section><div class="content related-content-wrap"><p>2 eggs</p></div></body>'), '1 cup flour\n2 eggs', 'post and content wrappers are never dropped by class');
assert.equal(htmlToText('<body><div class="content-sidebar-wrap"><main class="content"><p>1 cup flour</p></main><aside class="sidebar sidebar-primary"><p>Side</p></aside></div><div class="has-sidebar"><p>2 eggs</p></div></body>'), '1 cup flour\n2 eggs', 'the Genesis content-sidebar-wrap is not a sidebar');
assert.equal(htmlToText('<body><div id="comments" class="comments"><p>Loved it</p></div><div id="respond">Reply</div><ol class="commentlist"><li>Nice</li></ol><div class="ad-container">Buy</div><div class="promo-box">Promo</div><div id="cookie-law-info-bar">Law</div><div class="gdpr-banner">GDPR</div><div class="social-share">S</div><div class="jp-relatedposts">R</div><p>Dough</p></body>'), 'Dough', 'comment threads, ads, promos, consent bars, share and related widgets are still dropped');

const textOnlyResult = await processImportRequest({ version: 1, jobId: 'text-001', createdAt: NOW(), url: 'https://fixture.life/grandmas-salad/' }, {
  now: NOW, fetchText: async (url) => page(await readFixture('recipe-text-only.html'), url),
});
assert.equal(textOnlyResult.status, 'success');
assert.equal(textOnlyResult.provider, 'text-parser');
assert.equal(textOnlyResult.draft.title, 'Grandma’s Crunchy Lemon Parmesan Salad', 'the content h1 (with its own apostrophe) is the authoritative title');
assert.equal(textOnlyResult.draft.heroImage, 'https://images.example.com/lemon-salad.jpg');
assert.equal(textOnlyResult.draft.ingredients.length, 6);
assert.equal(textOnlyResult.draft.instructions.length, 3);
const textOnlyJson = JSON.stringify(textOnlyResult.draft);
assert.ok(!/noscript|a > b|Explore More|Cookbook|Sign me up/.test(textOnlyJson), textOnlyJson);
assertValidDraft(textOnlyResult.draft);

assert.equal(pickRecipeTitle({ pageTitle: "Nana&#039;s Viral Crunchy Lemon Parmesan Salad - Erin O&#039;Brien" }), "Nana's Viral Crunchy Lemon Parmesan Salad");
assert.equal(pickRecipeTitle({ ogTitle: 'White Chicken Chili  Recipe • 5★' }), 'White Chicken Chili');
assert.equal(pickRecipeTitle({ pageTitle: 'Cooked - Viral Carrot Ribbon Salad', hostname: 'cooked.wiki' }), 'Viral Carrot Ribbon Salad', 'a site-name prefix is recognised from the host name');
assert.equal(pickRecipeTitle({ pageTitle: 'Cooked - Viral Carrot Ribbon Salad', siteName: 'Cooked' }), 'Viral Carrot Ribbon Salad', 'or from og:site_name');
assert.equal(pickRecipeTitle({ pageTitle: 'Lasagna | Pinch of Yum' }), 'Lasagna', 'without site knowledge the trailing part is the site suffix, however long');
assert.equal(pickRecipeTitle({ recipeName: 'Best Lasagna Recipe', ogTitle: 'ignored' }), 'Best Lasagna');
assert.equal(pickRecipeTitle({ ogTitle: 'Threads', h1: 'Instagram', pageTitle: 'Just a moment...' }), '');
assert.equal(pickRecipeTitle({ fallback: 'serves 2' }), '');
assert.equal(pickRecipeTitle({ fallback: '&noscript=1"' }), '');
assert.equal(pickRecipeTitle({ fallback: 'https://example.com/x' }), '');
assert.equal(pickRecipeTitle({ fallback: '#dinner #easy' }), '');
assert.equal(pickRecipeTitle({ fallback: 'Avery Kitchen on Instagram: Easy Tomato Pasta 🍝' }), 'Easy Tomato Pasta');
assert.equal(pickRecipeTitle({ fallback: 'Log in' }), '');

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------

const metric = parseIngredient('600g chicken thighs');
assert.deepEqual([metric.quantity, metric.unit, metric.ingredientName, metric.groceryCategory], [{ numerator: 600, denominator: 1 }, 'g', 'chicken thighs', 'Meat & Seafood']);
assert.deepEqual(parseIngredient('1.5kg potatoes').quantity, { numerator: 3, denominator: 2 });
assert.equal(parseIngredient('250ml coconut milk').unit, 'ml');
const range = parseIngredient('2-3 cloves garlic, minced');
assert.deepEqual([range.quantity, range.quantityMax, range.unit, range.approximate, range.preparation], [{ numerator: 2, denominator: 1 }, { numerator: 3, denominator: 1 }, 'clove', true, 'minced']);
const splash = parseIngredient('A splash of water');
assert.deepEqual([splash.quantity, splash.approximate, splash.skipGrocery, splash.ingredientName], [null, true, true, 'water']);
assert.equal(parseIngredient('pinch of salt').skipGrocery, true);
assert.equal(parseIngredient('salt to taste').toTaste, true);
assert.equal(parseIngredient('1 (14 oz) can chickpeas, drained').note, '14 oz');
assert.equal(parseIngredient('1 (14 oz) can chickpeas, drained').unit, 'can');
const jalapeno = parseIngredient('1 jalapeño pepper, seeds and ribs removed, finely chopped');
assert.deepEqual([jalapeno.ingredientName, jalapeno.preparation], ['jalapeño pepper', 'seeds and ribs removed, finely chopped']);
assert.equal(parseIngredient('Salt (to taste)').toTaste, true, 'a parenthetical "to taste" counts');
assert.equal(parseIngredient('Kosher salt, plus more to taste').ingredientName, 'Kosher salt');
assert.equal(parseIngredient('2 tbsp butter, plus more for greasing').ingredientName, 'butter');
const halfLime = parseIngredient('Half a lime, plus lime wedges, for serving');
assert.deepEqual([halfLime.quantity, halfLime.ingredientName, halfLime.toTaste], [{ numerator: 1, denominator: 2 }, 'lime', true]);
for (const [line, category] of [
  ['8 flour tortillas', 'Bakery'], ['1 can chickpeas', 'Canned & Jarred'], ['2 cups black beans', 'Canned & Jarred'],
  ['4 cups chicken broth', 'Canned & Jarred'], ['1 can coconut milk', 'Canned & Jarred'], ['2 tbsp tomato paste', 'Canned & Jarred'],
  ['2 large eggs', 'Dairy & Eggs'], ['8 oz cream cheese', 'Dairy & Eggs'], ['1 cup Greek yogurt', 'Dairy & Eggs'],
  ['1 red bell pepper', 'Produce'], ['1 tsp black pepper', 'Spices & Seasonings'], ['1 lb spaghetti', 'Pasta, Rice & Grains'],
  ['2 tablespoons olive oil', 'Sauces & Condiments'], ['1 vanilla bean', 'Spices & Seasonings'], ['1 cup green beans, trimmed', 'Produce'],
  ['1 jalapeño pepper, seeds and ribs removed, finely chopped', 'Produce'], ['1 red chili, sliced', 'Produce'], ['2 chiles', 'Produce'],
  ['1 tsp dried chiles', 'Spices & Seasonings'], ['1 tbsp chilli flakes', 'Spices & Seasonings'], ['1 tsp crushed red pepper', 'Spices & Seasonings'],
  ['1 tbsp fish sauce', 'Sauces & Condiments'], ['2 tbsp rice vinegar', 'Sauces & Condiments'], ['8 oz egg noodles', 'Pasta, Rice & Grains'],
  ['1 tsp cream of tartar', 'Pantry'], ['2 cups tortilla chips', 'Pantry'], ['1 cup bread crumbs', 'Pantry'], ['1 cup milk chocolate chips', 'Pantry'],
  ['2 tbsp mustard seeds', 'Spices & Seasonings'], ['1 tsp ground ginger', 'Spices & Seasonings'], ['1 cup bean sprouts', 'Produce'],
  ['1 can tuna', 'Canned & Jarred'], ['1 (10 oz) can cream of mushroom soup', 'Canned & Jarred'], ['1 lb chicken thighs', 'Meat & Seafood'], ['2 lb short ribs', 'Meat & Seafood'],
]) assert.equal(parseIngredient(line).groceryCategory, category, line);
for (const line of ['600g chicken', '2-3 cloves garlic', 'A splash of water', 'salt', '1 (14 oz) can chickpeas, drained']) assertClientIngredient(parseIngredient(line));

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

const readerJson = await readFixture('instagram-reader.json');
const reader = parseInstagramReaderPayload(readerJson, 'https://www.instagram.com/reel/ABC123/');
assert.equal(reader.creator, 'avery.kitchen');
assert.match(reader.caption, /Easy Tomato Pasta/);
assert.deepEqual(reader.relatedUrls.map((url) => url.href), ['https://recipes.example.com/tomato-pasta']);

const truncatedReaderPayload = JSON.parse(readerJson);
truncatedReaderPayload.data.metadata['og:description'] = 'avery.kitchen on August 23, 2026: “Easy Tomato Pasta. Ingredients in caption…”';
truncatedReaderPayload.data.description = truncatedReaderPayload.data.metadata['og:description'];
truncatedReaderPayload.data.content = `[avery.kitchen](https://www.instagram.com/avery.kitchen/) • 2d\n\n${reader.caption}\n\n[another.user](https://www.instagram.com/another.user/) Looks delicious!`;
assert.match(parseInstagramReaderPayload(truncatedReaderPayload, 'https://www.instagram.com/reel/ABC123/').caption, /12 oz spaghetti/, 'full reader markdown should beat truncated Open Graph text');

const captionDraft = parseRecipeCaption(reader.caption, { sourceURL: 'https://www.instagram.com/reel/ABC123/', sourceName: 'Instagram', author: '@avery.kitchen', heroImage: reader.heroImage });
assert.equal(captionDraft.title, 'Easy Tomato Pasta');
assert.equal(captionDraft.servings, 4);
assert.equal(captionDraft.ingredients.length, 5);
assert.equal(captionDraft.instructions.length, 4);
assert.equal(captionDraft.author, '@avery.kitchen');
assertValidDraft(captionDraft);

const emojiCaption = parseRecipeCaption('Crispy Potatoes\nINGREDIENTS 👇\n• 2 lb potatoes\n• 2 tbsp olive oil\nINSTRUCTIONS ⬇️\n1️⃣ Heat the oven.\n2️⃣ Roast until crisp.', { sourceURL: 'https://www.instagram.com/reel/EMOJI1/' });
assert.equal(emojiCaption.ingredients.length, 2);
assert.equal(emojiCaption.instructions.length, 2);

const narrativeCaption = parseRecipeCaption('Y’all debated about this, some even got mad at me lol.\nThe full recipe is finally here.\nMAC N CHEESE LASAGNA\nIngredients:\n1 lb pasta\nInstructions:\n1. Bake until bubbling.', {});
assert.equal(narrativeCaption.title, 'MAC N CHEESE LASAGNA');
const slashTitleCaption = parseRecipeCaption('Y’all debated about this.\nMac’n’cheese lasagna/Beefaroni/Hamburger Helper\nIngredients:\n1 lb pasta\nInstructions:\n1. Bake until bubbling.', {});
assert.equal(slashTitleCaption.title, 'Mac’n’cheese lasagna');

const modernCaption = parseRecipeCaption([
  'Lunches That Last, Episode 3: Chicken Caesar Baked Wraps 🥙🥬',
  'Save this one!',
  'Ingredients (Serves 3–4)',
  '600g cooked chicken', '4 large tortillas', 'Lighter Caesar dressing:', '2 tbsp Greek yoghurt', 'Splash of water to loosen',
  'How to make it',
  'Mix the dressing and loosen with water.', 'Roll everything up in the tortillas.', 'Bake at 200C for 12 minutes.',
  'Enjoy!!', 'Follow for more lunch ideas', 'https://example.com/app', '#lunch #mealprep',
].join('\n'), {});
assert.equal(modernCaption.title, 'Chicken Caesar Baked Wraps');
assert.equal(modernCaption.servings, 3);
assert.deepEqual(modernCaption.ingredients.map((item) => item.section), [null, null, 'Lighter Caesar dressing', 'Lighter Caesar dressing']);
assert.equal(modernCaption.ingredients[0].unit, 'g');
assert.equal(modernCaption.ingredients[3].skipGrocery, true);
assert.deepEqual(modernCaption.instructions.map((step) => step.text), ['Mix the dressing and loosen with water.', 'Roll everything up in the tortillas.', 'Bake at 200C for 12 minutes.']);
assertValidDraft(modernCaption);

const servesCaption = parseRecipeCaption('Serves 2\nYou will need:\n1 cup rice\n1 can coconut milk\nSteps:\nRinse the rice.\nSimmer for 15 minutes.', { title: 'Fixture Cook on Instagram: Coconut Rice' });
assert.equal(servesCaption.title, 'Coconut Rice', 'a "serves 2" line is never used as the title');
assert.equal(servesCaption.ingredients.length, 2);
assert.equal(servesCaption.instructions.length, 2);

// ---------------------------------------------------------------------------
// Instagram: embed first, reader fallback, Meta blocklist, sourceLinks
// ---------------------------------------------------------------------------

for (const [href, expected] of [
  ['https://www.instagram.com/p/ABC123/', 'ABC123'], ['https://www.instagram.com/reel/ABC123/?igsh=x', 'ABC123'],
  ['https://www.instagram.com/reels/ABC123', 'ABC123'], ['https://www.instagram.com/tv/ABC123/', 'ABC123'],
  ['https://www.instagram.com/avery.kitchen/reel/ABC123/', 'ABC123'], ['https://www.instagram.com/avery.kitchen/', null],
]) assert.equal(instagramShortcode(new URL(href)), expected, href);

const embedHtml = await readFixture('instagram-embed.html');
const embed = parseInstagramEmbed(embedHtml, 'https://www.instagram.com/reel/FIXTURE01/');
assert.equal(embed.creator, 'fixture.cook');
assert.match(embed.caption, /500g cooked chicken/);
assert.ok(!embed.caption.includes('View all 325 comments') && !/^fixture\.cook/.test(embed.caption), embed.caption);
assert.deepEqual(embed.relatedUrls.map((url) => url.href), ['https://recipes.example.com/caesar-wraps']);
assert.equal(parseInstagramEmbed(await readFixture('instagram-embed-missing.html'), 'https://www.instagram.com/reel/GONE1/'), null);

const embedMock = mockFetch([['https://www.instagram.com/p/FIXTURE01/embed/captioned/', (url) => page(embedHtml, url.href)]]);
const embedResult = await processImportRequest({ version: 1, jobId: 'ig-embed-001', createdAt: NOW(), url: 'https://www.instagram.com/reel/FIXTURE01/?igsh=abc' }, { now: NOW, fetchText: embedMock.fetchText });
assert.equal(embedResult.status, 'success');
assert.equal(embedResult.provider, 'instagram-caption');
assert.deepEqual(embedMock.calls, [{ href: 'https://www.instagram.com/p/FIXTURE01/embed/captioned/', profile: 'browser' }], 'embed success never touches the reader');
assert.equal(embedResult.draft.title, 'Chicken Caesar Baked Wraps');
assert.equal(embedResult.draft.author, '@fixture.cook');
assert.equal(embedResult.draft.sourceURL, 'https://www.instagram.com/reel/FIXTURE01/');
assert.equal(embedResult.draft.sourceName, 'Instagram');
assert.equal(embedResult.draft.servings, 3);
assert.equal(embedResult.draft.ingredients.length, 8);
assert.equal(embedResult.draft.instructions.length, 3);
assert.equal(embedResult.draft.notes, '');
assert.deepEqual(embedResult.draft.sourceLinks, [
  { kind: 'instagram-post', url: 'https://www.instagram.com/reel/FIXTURE01/', label: 'Original Instagram post' },
  { kind: 'creator-profile', url: 'https://www.instagram.com/fixture.cook/', label: 'Instagram creator @fixture.cook' },
]);
assert.deepEqual(embedResult.sourcesChecked.map((source) => [source.kind, source.url]), [
  ['instagram-post', 'https://www.instagram.com/reel/FIXTURE01/?igsh=abc'],
  ['instagram-post', 'https://www.instagram.com/reel/FIXTURE01/'],
]);
assertClientSourceContract(embedResult, 'https://www.instagram.com/reel/FIXTURE01/?igsh=abc');
assert.match(embedResult.warnings[0], /did not transcribe/i);
assertValidDraft(embedResult.draft);

const indexUrl = 'https://www.instagram.com/p/FIXTURE01/?img_index=2';
const indexMock = mockFetch([['https://www.instagram.com/p/FIXTURE01/embed/captioned/', (url) => page(embedHtml, url.href)]]);
const indexResult = await processImportRequest({ version: 1, jobId: 'ig-index-001', createdAt: NOW(), url: indexUrl }, { now: NOW, fetchText: indexMock.fetchText });
assert.equal(indexResult.status, 'success');
assert.equal(indexResult.draft.sourceURL, 'https://www.instagram.com/p/FIXTURE01/');
assert.equal(indexResult.sourcesChecked[0].url, indexUrl, 'carousel index parameters are stripped, but the sent link is still listed');
assertClientSourceContract(indexResult, indexUrl);

const request = JSON.parse(await readFixture('request-instagram.json'));
const missingEmbed = await readFixture('instagram-embed-missing.html');
const readerMock = mockFetch([
  [/instagram\.com\/p\/ABC123\/embed/, (url) => page(missingEmbed, url.href)],
  [/^https:\/\/r\.jina\.ai\/https:\/\/www\.instagram\.com\/reel\/ABC123\//, (url) => ({ status: 200, headers: {}, body: readerJson, url })],
]);
const captionResult = await processImportRequest(request, { now: NOW, fetchText: readerMock.fetchText });
assert.deepEqual(readerMock.calls.map((call) => call.href), ['https://www.instagram.com/p/ABC123/embed/captioned/', 'https://r.jina.ai/https://www.instagram.com/reel/ABC123/'], 'an embed miss falls back to the reader, and a complete caption stops there');
assert.equal(captionResult.status, 'success');
assert.equal(captionResult.provider, 'instagram-caption');
assert.equal(captionResult.jobId, request.jobId);
assert.equal(captionResult.importerVersion, IMPORTER_VERSION);
assert.equal(captionResult.draft.sourceURL, 'https://www.instagram.com/reel/ABC123/');
assert.equal(captionResult.draft.heroImage, null);
assert.deepEqual(captionResult.sourcesChecked.map((source) => source.url), [request.url, 'https://www.instagram.com/reel/ABC123/']);
assertClientSourceContract(captionResult, request.url);

const metaLinksEmbed = embedHtml
  .replace(/<div class="Caption">[\s\S]*?<div class="CaptionComments">/, '<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/avery.kitchen/">avery.kitchen</a><br />Lemony sheet-pan chicken tonight! Full recipe: https://recipes.example.com/lemon-chicken<br />Also https://about.meta.com/ https://www.threads.com/ https://developers.facebook.com/ https://www.meta.ai/ https://l.instagram.com/?u=https%3A%2F%2Fwww.meta.com%2F<div class="CaptionComments">')
  .replace(/<script nonce[\s\S]*?<\/script>/, '');
const linkedMock = mockFetch([
  [/instagram\.com\/p\/ABC123\/embed/, (url) => page(metaLinksEmbed, url.href)],
  ['https://r.jina.ai/https://www.instagram.com/avery.kitchen/', async (url) => ({ status: 200, headers: {}, body: await readFixture('instagram-profile-reader.json'), url })],
  ['https://recipes.example.com/lemon-chicken', (url) => page(html, url.href)],
]);
const linkedResult = await processImportRequest({ ...request, jobId: 'fixture-job-002' }, { now: NOW, fetchText: linkedMock.fetchText });
assert.equal(linkedResult.status, 'success');
assert.equal(linkedResult.provider, 'linked-recipe');
assert.equal(linkedResult.draft.title, 'Lemony Sheet-Pan Chicken');
assert.equal(linkedResult.draft.sourceURL, 'https://www.instagram.com/reel/ABC123/');
assert.equal(linkedResult.draft.sourceName, 'Instagram');
assert.equal(linkedResult.draft.notes, '', 'recipe links live in sourceLinks, not notes');
assert.deepEqual(linkedResult.draft.sourceLinks, [
  { kind: 'instagram-post', url: 'https://www.instagram.com/reel/ABC123/', label: 'Original Instagram post' },
  { kind: 'creator-profile', url: 'https://www.instagram.com/avery.kitchen/', label: 'Instagram creator @avery.kitchen' },
  { kind: 'recipe-page', url: 'https://recipes.example.com/lemon-chicken', label: 'Full recipe on recipes.example.com' },
]);
assert.deepEqual(linkedResult.sourcesChecked.map((source) => source.kind), ['instagram-post', 'instagram-post', 'creator-profile', 'recipe-page']);
assertClientSourceContract(linkedResult, request.url);
assert.ok(linkedMock.calls.every((call) => !/meta\.|threads\.|facebook\.com/.test(call.href)), 'Meta boilerplate links are never queued');

const rankedUrls = rankRelatedUrls([
  new URL('https://avery.example.com/about'),
  new URL('https://linktr.ee/avery.kitchen'),
  new URL('https://avery.example.com/lemony-sheet-pan-chicken'),
], ['lemony', 'sheet', 'pan', 'chicken']);
assert.deepEqual(rankedUrls.map((url) => url.href), ['https://avery.example.com/lemony-sheet-pan-chicken', 'https://linktr.ee/avery.kitchen', 'https://avery.example.com/about']);

const hubMock = mockFetch([
  [/instagram\.com\/p\/HUB123\/embed/, (url) => page(missingEmbed, url.href)],
  [/r\.jina\.ai\/https:\/\/www\.instagram\.com\/reel\/HUB123/, async (url) => ({ status: 200, headers: {}, body: await readFixture('instagram-reader-hub.json'), url })],
  ['https://r.jina.ai/https://www.instagram.com/avery.kitchen/', async (url) => ({ status: 200, headers: {}, body: await readFixture('instagram-profile-hub.json'), url })],
  ['https://linktr.ee/avery.kitchen', async (url) => page(await readFixture('link-hub-page.html'), url.href)],
  ['https://avery.example.com/lemony-sheet-pan-chicken', (url) => page(html, url.href)],
]);
const hubResult = await processImportRequest({ ...request, jobId: 'fixture-job-003', url: 'https://www.instagram.com/reel/HUB123/' }, { now: NOW, fetchText: hubMock.fetchText });
assert.equal(hubResult.status, 'success');
assert.equal(hubResult.provider, 'linked-recipe');
assert.equal(hubResult.draft.title, 'Lemony Sheet-Pan Chicken');
assert.equal(hubResult.draft.sourceLinks.at(-1).url, 'https://avery.example.com/lemony-sheet-pan-chicken');
assert.deepEqual(hubResult.sourcesChecked.map((source) => source.kind), ['instagram-post', 'creator-profile', 'recipe-page', 'recipe-page']);
assert.equal(hubResult.sourcesChecked[2].label, 'Creator links on linktr.ee');
assert.equal(hubMock.calls.length, 5, 'ranking should reach the linked recipe without visiting about/shop pages');

// ---------------------------------------------------------------------------
// Client-rendered pages and the reader fallback
// ---------------------------------------------------------------------------

const clientHtml = await readFixture('recipe-client-rendered.html');
const readerPage = await readFixture('reader-page.json');
const clientMock = mockFetch([
  ['https://app.example.recipes/r/smoky-chipotle-black-bean-tacos', (url) => page(clientHtml, url.href)],
  ['https://r.jina.ai/https://app.example.recipes/r/smoky-chipotle-black-bean-tacos', (url) => ({ status: 200, headers: {}, body: readerPage, url })],
]);
const clientResult = await processImportRequest({ version: 1, jobId: 'client-001', createdAt: NOW(), url: 'https://app.example.recipes/r/smoky-chipotle-black-bean-tacos' }, { now: NOW, fetchText: clientMock.fetchText });
assert.equal(clientResult.status, 'success');
assert.equal(clientResult.provider, 'public-reader');
assert.equal(clientResult.draft.title, 'Smoky Chipotle Black Bean Tacos');
assert.equal(clientResult.draft.ingredients.length, 5);
assert.equal(clientResult.draft.instructions.length, 3);
assert.equal(clientMock.calls.length, 2);

const excludedMock = mockFetch([[/allrecipes\.com/, (url) => page(clientHtml, url.href)]]);
const excludedResult = await processImportRequest({ version: 1, jobId: 'client-002', createdAt: NOW(), url: 'https://www.allrecipes.com/recipe/1/thing/' }, { now: NOW, fetchText: excludedMock.fetchText });
assert.equal(excludedResult.status, 'error');
assert.equal(excludedMock.calls.length, 1, 'People Inc. domains are never sent to the reader');

// ---------------------------------------------------------------------------
// Decompression and charsets
// ---------------------------------------------------------------------------

const plain = Buffer.from('<html><body>hello</body></html>');
const decodedText = async (buffer, headers, maxBytes) => {
  const decoded = await decodeResponseBodyLenient(buffer, headers, maxBytes);
  assert.deepEqual([decoded.truncated, decoded.error], [false, null], 'a body within the cap decodes whole');
  return decoded.body.toString();
};
assert.equal(await decodedText(zlib.gzipSync(plain), { 'content-encoding': 'gzip' }), plain.toString());
assert.equal(await decodedText(zlib.brotliCompressSync(plain), { 'content-encoding': 'br' }), plain.toString());
assert.equal(await decodedText(zlib.deflateSync(plain), { 'content-encoding': 'deflate' }), plain.toString());
assert.equal(await decodedText(zlib.deflateRawSync(plain), { 'content-encoding': 'deflate' }), plain.toString());
assert.equal(await decodedText(zlib.brotliCompressSync(zlib.gzipSync(plain)), { 'content-encoding': 'gzip, br' }), plain.toString(), 'chained encodings are undone in reverse order');
assert.equal(await decodedText(plain, {}), plain.toString());
assert.equal(await decodedText(plain, { 'content-encoding': 'identity' }), plain.toString());
const overCap = await decodeResponseBodyLenient(zlib.gzipSync(Buffer.alloc(200_000, 0x41)), { 'content-encoding': 'gzip' }, 50_000);
assert.deepEqual([overCap.body.length, overCap.truncated, overCap.error], [50_000, true, null], 'an oversize body is cut at the cap, never rejected');
const notGzip = await decodeResponseBodyLenient(Buffer.from('not gzip'), { 'content-encoding': 'gzip' });
assert.match(notGzip.error?.message ?? '', /decompressed/, 'an unreadable stream reports its error');

const latin1 = await readFixtureBytes('recipe-latin1.html');
const latin1Text = decodeBodyText(latin1, 'text/html');
assert.match(latin1Text, /Jalapeño Poppers/, 'meta http-equiv charset is honored');
assert.match(decodeBodyText(latin1, 'text/html; charset=ISO-8859-1'), /Jalapeño/);
assert.match(decodeBodyText(Buffer.from('<title>Jalapeño</title>', 'utf8'), 'text/html'), /Jalapeño/);
const latin1Draft = extractRecipeFromHtml(latin1Text, new URL('https://grill.example.com/poppers')).chosen.draft;
assert.equal(latin1Draft.title, 'Jalapeño Poppers');
assert.equal(latin1Draft.ingredients[0].rawText, '12 jalapeños, halved');
assert.equal(latin1Draft.instructions.length, 2);

// ---------------------------------------------------------------------------
// Fetch ladder with a fake transport
// ---------------------------------------------------------------------------

const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const okHtml = '<html><head><title>Fine</title></head><body>' + 'recipe '.repeat(3_000) + '</body></html>';
function fakeTransport(responses) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ href: url.href, userAgent: options.headers['User-Agent'], accept: options.headers.Accept, secFetch: options.headers['Sec-Fetch-Mode'] });
    const next = responses.shift();
    if (!next) throw new Error('No more fake responses.');
    return { status: next.status, headers: next.headers ?? { 'content-type': 'text/html' }, body: Buffer.isBuffer(next.body) ? next.body : Buffer.from(next.body ?? '') };
  };
  return { calls, transport };
}

let additional = 0;
const forbidden = fakeTransport([{ status: 403, body: 'Forbidden' }, { status: 200, body: okHtml }]);
const forbiddenResult = await fetchWithFallbacks('https://example.com/recipe', { transport: forbidden.transport, resolver, onAdditionalRequest: () => { additional += 1; } });
assert.equal(forbiddenResult.status, 200);
assert.equal(forbidden.calls.length, 2);
assert.equal(forbidden.calls[0].userAgent, HONEST_USER_AGENT);
assert.equal(forbidden.calls[1].userAgent, BROWSER_USER_AGENT);
assert.equal(forbidden.calls[1].secFetch, 'navigate');
assert.equal(additional, 1, 'the retry counts against the request budget');

const challenged = fakeTransport([{ status: 200, body: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>' }, { status: 200, body: okHtml }]);
assert.equal((await fetchWithFallbacks('https://example.com/recipe', { transport: challenged.transport, resolver })).body, okHtml);
assert.equal(challenged.calls.length, 2, 'a 200 challenge page still triggers the browser retry');

const clean = fakeTransport([{ status: 200, body: okHtml }]);
assert.equal((await fetchWithFallbacks('https://example.com/recipe', { transport: clean.transport, resolver })).body, okHtml);
assert.equal(clean.calls.length, 1);

const notFound = fakeTransport([{ status: 404, body: 'nope' }]);
await assert.rejects(fetchWithFallbacks('https://example.com/missing', { transport: notFound.transport, resolver }), /HTTP 404/);
assert.equal(notFound.calls.length, 1, 'a 404 is final');

const stubborn = fakeTransport([{ status: 403, body: 'no' }, { status: 403, body: 'no' }]);
await assert.rejects(fetchWithFallbacks('https://example.com/blocked', { transport: stubborn.transport, resolver }), /HTTP 403/);
assert.equal(stubborn.calls.length, 2);

// A readable page that merely resembled a challenge is kept when the retry does worse.
const heldBody = '<html><head><title>Lemon Cake</title></head><body><p>Please enable JavaScript to load comments.</p><li>1 cup flour</li></body></html>';
const heldPage = fakeTransport([{ status: 200, body: heldBody }, { status: 403, body: 'no' }]);
const heldResult = await fetchWithFallbacks('https://example.com/wprm_print/lemon-cake', { transport: heldPage.transport, resolver });
assert.equal(heldPage.calls.length, 2);
assert.equal(heldResult.body, heldBody, 'the first 2xx is returned instead of the 403');

const readerLimited = fakeTransport([{ status: 429, body: '' }]);
await assert.rejects(fetchWithFallbacks('https://r.jina.ai/https://example.com/x', { transport: readerLimited.transport, resolver }), /HTTP 429/);
assert.equal(readerLimited.calls.length, 1, 'the reader has fixed headers, so a retry could only repeat the first attempt');
assert.equal(readerLimited.calls[0].accept, 'application/json');

const redirected = fakeTransport([
  { status: 301, headers: { location: 'http://example.com/final-recipe' }, body: '' },
  { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.from(okHtml)) },
]);
const redirectResult = await fetchWithFallbacks('https://example.com/old', { transport: redirected.transport, resolver });
assert.equal(redirected.calls[1].href, 'https://example.com/final-recipe', 'http redirect targets are retried as https');
assert.equal(redirectResult.url.href, 'https://example.com/final-recipe');
assert.equal(redirectResult.body, okHtml, 'gzip bodies are decoded');

const browserOnly = fakeTransport([{ status: 200, body: okHtml }]);
await fetchWithFallbacks('https://www.instagram.com/p/X/embed/captioned/', { transport: browserOnly.transport, resolver, profile: 'browser' });
assert.equal(browserOnly.calls[0].userAgent, BROWSER_USER_AGENT);

assert.equal(looksLikeBotChallenge(200, '<title>Attention Required! | Cloudflare</title>'), true);
assert.equal(looksLikeBotChallenge(429, ''), true);
assert.equal(looksLikeBotChallenge(200, okHtml), false);
assert.equal(looksLikeBotChallenge(200, '<title>Lemon Cake</title><form class="g-recaptcha"></form><li>1 cup flour</li>'), false, 'a reCAPTCHA comment form is not a challenge');
assert.equal(looksLikeBotChallenge(200, '<title>Lemon Cake</title><script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script>'), false, 'Cloudflare injects that script into ordinary pages');
assert.equal(looksLikeBotChallenge(200, '<title>Captcha Check</title>'), true);
assert.equal(looksLikeBotChallenge(200, '<title>Site</title><div id="px-captcha"></div>'), true);

// ---------------------------------------------------------------------------
// URL hygiene and safety
// ---------------------------------------------------------------------------

assert.equal(normalizeSourceUrl('https://cooking.example.com/recipes/1?smid=ck-recipe-iOS-share&sgrp=c-cb&utm_source=x&fbclid=1&p=2#top').href, 'https://cooking.example.com/recipes/1?p=2');
assert.equal(normalizeSourceUrl('https://www.instagram.com/reel/ABC/?igsh=abc').href, 'https://www.instagram.com/reel/ABC/');
assert.equal(normalizeSourceUrl('https://blog.example.com/?s=chili').href, 'https://blog.example.com/?s=chili', '"s" is only tracking on known hosts');
assert.equal(normalizeSourceUrl('https://youtu.be/abc?si=track').href, 'https://youtu.be/abc');

for (const unsafe of [
  'http://example.com/recipe', 'https://localhost/recipe', 'https://127.0.0.1/recipe', 'https://10.0.0.1/recipe',
  'https://[::1]/recipe', 'https://user:password@example.com/recipe', 'https://example.com:8443/recipe',
]) assert.throws(() => validateUrlSyntax(unsafe), unsafe);
assert.equal(validateUrlSyntax('https://example.com/recipe').href, 'https://example.com/recipe');
assert.equal(isPublicIpAddress('8.8.8.8'), true);
assert.equal(isPublicIpAddress('192.168.1.1'), false);
assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
assert.equal(isPublicIpAddress('fc00::1'), false);

const invalidResult = await processImportRequest({ version: 1, jobId: 'bad-001', createdAt: NOW(), url: 'http://example.com/x' }, { now: NOW, fetchText: async () => { throw new Error('must not fetch'); } });
assert.equal(invalidResult.status, 'error');
assert.equal(invalidResult.importerVersion, IMPORTER_VERSION);
assert.match(invalidResult.error, /HTTPS/);

// ---------------------------------------------------------------------------
// Second-pass audit: result shapes
// ---------------------------------------------------------------------------

assert.equal(IMPORTER_VERSION, '2');
const partialHtml = '<html><head><title>Partial Recipe | Site</title><script type="application/ld+json">{"@type":"Recipe","name":"Partial Recipe","recipeIngredient":["1 cup rice","2 cups water"]}</script></head><body><h1>Partial Recipe</h1></body></html>';
const partialResult = await processImportRequest({ version: 1, jobId: 'partial-001', createdAt: NOW(), url: 'https://www.allrecipes.com/recipe/9/partial/' }, { now: NOW, fetchText: async (url) => page(partialHtml, url) });
assert.equal(partialResult.status, 'partial');
assert.equal(partialResult.provider, 'schema-org');
assert.ok(partialResult.warnings.some((warning) => /Only part of the recipe/.test(warning)));
for (const result of [nytResult, partialResult, paywallResult, invalidResult]) {
  assert.equal(result.importerVersion, '2', `a ${result.status} result carries importerVersion`);
  assert.equal(result.version, 1);
}

// ---------------------------------------------------------------------------
// Second-pass audit: JSON-LD (@id graphs, trailing comments, control characters, IRI types, steps, entities)
// ---------------------------------------------------------------------------

const yoastHtml = await readFixture('recipe-yoast-graph.html');
const yoastMock = mockFetch([[/bakes\.example\.com/, (url) => page(yoastHtml, url.href)]]);
const yoastResult = await processImportRequest({ version: 1, jobId: 'yoast-001', createdAt: NOW(), url: 'https://bakes.example.com/brown-butter-miso-cookies/' }, { now: NOW, fetchText: yoastMock.fetchText });
assert.equal(yoastResult.status, 'success');
assert.equal(yoastResult.provider, 'schema-org');
assert.equal(yoastResult.draft.title, 'Brown Butter Miso Cookies');
assert.equal(yoastResult.draft.author, 'Fixture Baker', 'the author is resolved through @id, name only');
assert.equal(yoastResult.draft.heroImage, 'https://bakes.example.com/wp-content/uploads/miso-cookies.jpg', 'the image is resolved through @id');
assert.equal(yoastResult.draft.description, 'Salty-sweet cookies with crisp edges.', 'a raw tab inside a JSON string literal is tolerated');
assert.equal(yoastResult.draft.servings, 24, 'a QuantitativeValue yield');
assert.equal(yoastResult.draft.prepTime, null, 'PT0M is not a duration');
assert.equal(yoastResult.draft.cookTime, 12);
assert.equal(yoastResult.draft.totalTime, 60);
assert.deepEqual(yoastResult.draft.ingredients.map((item) => item.rawText), ['1 ½ cups all-purpose flour', '½ cup unsalted butter', '2 tablespoons white miso', '1 large egg', '¾ cup brown sugar, packed', '1 tsp crème fraîche', 'One 3- to 5-pound chuck roast'], 'entities decode, inline bullets separate, newline-joined strings split');
assert.deepEqual(yoastResult.draft.ingredients[0].quantity, { numerator: 3, denominator: 2 }, 'a space-separated mixed number');
assert.deepEqual(yoastResult.draft.instructions.map((step) => step.text), ['Brown the butter', 'Whisk the miso into the warm butter. Tip: Let it cool before adding the egg.', 'Scoop and bake for 12 minutes.'], 'name-only steps, stripped prefixes, tips appended, ItemList items unwrapped');
const roast = yoastResult.draft.ingredients.at(-1);
assert.deepEqual([roast.quantity, roast.unit, roast.ingredientName, roast.note, roast.groceryCategory], [{ numerator: 1, denominator: 1 }, 'each', 'chuck roast', '3–5 lb', 'Meat & Seafood']);
assertValidDraft(yoastResult.draft);
assert.equal(yoastMock.calls.length, 1, 'complete structured data needs no fallback fetch');

assert.equal(extractRecipeJsonLd('<script type="application/ld+json">{"@type":"Recipe","name":"Cached"}<!-- cached --></script>')[0]?.name, 'Cached', 'a block followed by an HTML comment');
assert.deepEqual(extractRecipeJsonLd('<script type="application/ld+json">{"@type":"Recipe","name":"Ctrl\tTab","description":"line\nbreak"}</script>').map((recipe) => [recipe.name, recipe.description]), [['Ctrl Tab', 'line break']], 'raw control characters inside strings become spaces');
assert.deepEqual(extractRecipeJsonLd('<script type="application/ld+json">[{"@type":"https://schema.org/Recipe","name":"IRI"},{"@type":"schema:Recipe","name":"Prefixed"}]</script>').map((recipe) => recipe.name), ['IRI', 'Prefixed']);

assert.equal(draftFromSchemaRecipe({ '@type': 'Recipe', name: 'A', author: [{ '@type': 'Person', name: 'Ada' }, { '@type': 'Person', name: 'Bo' }, { '@type': 'Person', name: 'Cy' }] }, exampleUrl).author, 'Ada & Bo', 'the first two names');
assert.equal(draftFromSchemaRecipe({ '@type': 'Recipe', name: 'A', author: { '@id': 'https://x.example.com/#/schema/person/1' } }, exampleUrl).author, null, 'an unresolved @id is never the author');
assert.equal(draftFromSchemaRecipe({ '@type': 'Recipe', name: 'A', author: 'https://x.example.com/about' }, exampleUrl).author, null, 'a URL is never the author');

const sevenSteps = draftFromSchemaRecipe({ '@type': 'Recipe', name: 'Seven', recipeInstructions: [
  ['<p>Preheat.</p>', '<p>Bake.</p>'],
  { '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'HowToStep', name: 'Only a name', text: '' } }] },
  { '@type': 'HowToStep', text: '1. Prefixed step' },
  { '@type': 'HowToStep', text: 'Step 2 Another prefixed' },
  { '@type': 'HowToTip', text: 'Use a hot pan.' },
] }, exampleUrl);
assert.deepEqual(sevenSteps.instructions.map((step) => step.text), ['Preheat.', 'Bake.', 'Only a name', 'Prefixed step', 'Another prefixed Tip: Use a hot pan.']);
assert.ok(!sevenSteps.instructions.some((step) => /<[a-z]/i.test(step.text)), 'no tags survive in steps');

for (const [entity, expected] of [
  ['&frac12;', '½'], ['&frac14;', '¼'], ['&frac34;', '¾'], ['&deg;', '°'], ['&bull;', '•'], ['&times;', '×'], ['&middot;', '·'],
  ['&eacute;', 'é'], ['&egrave;', 'è'], ['&ecirc;', 'ê'], ['&ntilde;', 'ñ'], ['&ccedil;', 'ç'], ['&uuml;', 'ü'], ['&ouml;', 'ö'], ['&auml;', 'ä'],
  ['&agrave;', 'à'], ['&aacute;', 'á'], ['&iacute;', 'í'], ['&oacute;', 'ó'], ['&uacute;', 'ú'], ['&szlig;', 'ß'], ['&icirc;', 'î'], ['&yuml;', 'ÿ'],
  ['&thorn;', 'þ'], ['&Eacute;', 'É'], ['&aring;', 'å'], ['&oslash;', 'ø'], ['&nbsp;', ' '],
]) assert.equal(htmlToText(`x${entity}y`), `x${expected}y`, entity);
assert.deepEqual(draftFromSchemaRecipe({ '@type': 'Recipe', name: 'NL', recipeIngredient: '2 cups flour\n1 egg' }, exampleUrl).ingredients.map((item) => item.rawText), ['2 cups flour', '1 egg'], 'a single newline-joined recipeIngredient string');
assert.deepEqual(draftFromSchemaRecipe({ '@type': 'Recipe', name: 'Tags', recipeIngredient: ['2 cups <a href="/flour"><strong>flour</strong></a>', '<li>1 egg</li><li>2 tsp salt</li>'] }, exampleUrl).ingredients.map((item) => item.rawText), ['2 cups flour', '1 egg', '2 tsp salt'], 'inline tags are stripped and lists split');
const mixedNumber = parseIngredient('1 ½ cups milk');
assert.deepEqual([mixedNumber.quantity, mixedNumber.unit, mixedNumber.ingredientName], [{ numerator: 3, denominator: 2 }, 'cup', 'milk']);

// ---------------------------------------------------------------------------
// Second-pass audit: ingredient lines seen in the live run
// ---------------------------------------------------------------------------

const foodNetwork = parseIngredient('One 3- to 5-pound chuck roast');
assert.deepEqual([foodNetwork.quantity, foodNetwork.unit, foodNetwork.ingredientName, foodNetwork.note, foodNetwork.groceryCategory], [{ numerator: 1, denominator: 1 }, 'each', 'chuck roast', '3–5 lb', 'Meat & Seafood']);
const twoOrThree = parseIngredient('2 or 3 tablespoons olive oil');
assert.deepEqual([twoOrThree.quantity, twoOrThree.quantityMax, twoOrThree.unit, twoOrThree.ingredientName], [{ numerator: 2, denominator: 1 }, { numerator: 3, denominator: 1 }, 'tbsp', 'olive oil']);
const twoCans = parseIngredient('Two 15-ounce cans black beans, drained');
assert.deepEqual([twoCans.quantity, twoCans.unit, twoCans.ingredientName, twoCans.note, twoCans.preparation, twoCans.groceryCategory], [{ numerator: 2, denominator: 1 }, 'can', 'black beans', '15 oz', 'drained', 'Canned & Jarred']);
const inchPieces = parseIngredient('One 4-pound chicken, cut into 2-to-3-inch pieces');
assert.deepEqual([inchPieces.quantity, inchPieces.ingredientName, inchPieces.note, inchPieces.preparation], [{ numerator: 1, denominator: 1 }, 'chicken', '4 lb', 'cut into 2-to-3-inch pieces']);
assert.deepEqual(parseIngredient('2 2-to-3-inch cinnamon sticks').note, '2–3 in');
assert.deepEqual(parseIngredient('Half a lime').quantity, { numerator: 1, denominator: 2 });
assert.equal(parseIngredient('A splash of water').quantity, null, 'word amounts still win over counts');
assert.equal(parseIngredient('One handful of spinach').unit, 'handful');
for (const line of ['One 3- to 5-pound chuck roast', 'Two 15-ounce cans black beans, drained', '2 or 3 tablespoons olive oil']) assertClientIngredient(parseIngredient(line));

// ---------------------------------------------------------------------------
// Second-pass audit: visible-text pages and captions
// ---------------------------------------------------------------------------

const noisyHtml = await readFixture('recipe-noisy-text.html');
const noisyMock = mockFetch([[/table\.example\.com/, (url) => page(noisyHtml, url.href)]]);
const noisyResult = await processImportRequest({ version: 1, jobId: 'noisy-001', createdAt: NOW(), url: 'https://table.example.com/garlic-bread/' }, { now: NOW, fetchText: noisyMock.fetchText });
assert.equal(noisyResult.status, 'success');
assert.equal(noisyResult.provider, 'text-parser');
assert.equal(noisyResult.draft.title, 'Garlic Bread with Herb Butter', 'the content h1 wins over the header logo h1 and the og:title site suffix');
assert.equal(noisyResult.draft.servings, 4);
assert.deepEqual(noisyResult.draft.ingredients.map((item) => item.rawText), ['1 loaf bread', '2 tbsp butter', '2 cloves garlic, minced', 'Fresh parsley for garnish'], 'a numbered ingredient list stays ingredients and "5 from 12 votes" is not one');
assert.deepEqual(noisyResult.draft.instructions.map((step) => step.text), ['Preheat the oven to 400°F.', 'Spread the herb butter over the bread.', 'Bake for 10 minutes until golden.'], 'a Procedure heading, prefixes removed, steps end at Notes');
assert.equal(noisyResult.draft.notes, 'Store leftovers wrapped in foil for up to 2 days.');
assert.equal(noisyMock.calls.length, 1, 'a complete text result does not reach the reader');
const noisyJson = JSON.stringify(noisyResult.draft);
assert.ok(!/Calories|Loved it|chili flakes|sourdough|Cheesy Bread|Sign me up|support us|Popular|Accept|Pin recipe|Fixture Table/.test(noisyJson), noisyJson);
assertValidDraft(noisyResult.draft);
const noisyText = htmlToText(noisyHtml);
assert.ok(!/Fixture Table|Recipes|Home|Popular|We use cookies|Share|Loved it|Related recipes|Sign me up|support us|not content/.test(noisyText), noisyText);
assert.ok(/Garlic Bread with Herb Butter/.test(noisyText) && /1 loaf bread/.test(noisyText), 'the article itself survives despite the body carrying class="category-cookies"');

const numberedList = parseRecipeCaption('Garlic Bread\nIngredients:\n1. 1 loaf bread\n2. 2 tbsp butter\n3. 2 cloves garlic\nInstructions:\n1. Preheat oven.\nStep 2: Spread butter.', {});
assert.deepEqual(numberedList.ingredients.map((item) => item.rawText), ['1 loaf bread', '2 tbsp butter', '2 cloves garlic']);
assert.deepEqual(numberedList.instructions.map((step) => step.text), ['Preheat oven.', 'Spread butter.']);

for (const heading of ['Ingredients (Serves 4):', 'INGREDIENTS 👇', 'What you need', 'You will need', 'Shopping list', 'What you need:']) {
  const draft = parseRecipeCaption(`Fixture Dish\n${heading}\n2 eggs\n1 cup flour\nHow to make:\nMix well.\nBake it.`, {});
  assert.deepEqual([draft.ingredients.length, draft.instructions.length], [2, 2], heading);
}
for (const heading of ['How to make:', 'Steps', 'Procedure', 'Directions', 'Method']) {
  const draft = parseRecipeCaption(`Fixture Dish\nIngredients:\n2 eggs\n1 cup flour\n${heading}\nMix well.\nBake it.`, {});
  assert.deepEqual([draft.ingredients.length, draft.instructions.length], [2, 2], heading);
}
assert.deepEqual(parseRecipeCaption('Omelette\nIngredients:\n2 eggs, 1 cup flour, 1 tsp salt\nMethod:\nMix.\nCook.', {}).ingredients.map((item) => item.rawText), ['2 eggs', '1 cup flour', '1 tsp salt'], 'one comma-separated line splits when every part starts with a quantity');
assert.deepEqual(parseRecipeCaption('Soup\nIngredients:\n1 onion, finely chopped\nMethod:\nCook.', {}).ingredients.map((item) => item.rawText), ['1 onion, finely chopped'], 'a preparation clause is not a second ingredient');

assert.deepEqual(parseRecipeCaption('Chicken Tacos\n1 lb chicken\nSalt\nPepper\n2 limes\nSpray oil\n1 cup rice\nLime wedges\nFresh parsley for garnish\nMethod:\nCook.\nServe.', {}).ingredients.map((item) => item.rawText), ['1 lb chicken', 'Salt', 'Pepper', '2 limes', 'Spray oil', '1 cup rice', 'Lime wedges', 'Fresh parsley for garnish'], 'unquantified staples between ingredient lines are kept without a heading');
assert.deepEqual(parseRecipeCaption('Chicken Tacos\n1 lb chicken\nSo good you guys\nMake it tonight\n2 limes\nMethod:\nCook.\nServe.', {}).ingredients.map((item) => item.rawText), ['1 lb chicken', '2 limes'], 'chatter between ingredient lines is still dropped');

const notesCaption = parseRecipeCaption('Pot Roast\nIngredients:\n1 roast\nMethod:\nBrown it.\nBraise it.\nNotes: Leftovers keep for 3 days.\nFreeze the rest.\nNutrition\nCalories 400\nComments\nGreat recipe, I used 2 cups broth.', {});
assert.deepEqual(notesCaption.instructions.map((step) => step.text), ['Brown it.', 'Braise it.'], 'steps end at Notes');
assert.equal(notesCaption.notes, 'Leftovers keep for 3 days.\nFreeze the rest.');
assert.equal(notesCaption.ingredients.length, 1, 'comments never add ingredients');

assert.equal(pickRecipeTitle({ fallback: 'Brown it.' }), '');
assert.equal(pickRecipeTitle({ h1: 'Brown it', ogTitle: 'Pot Roast | Site' }), 'Pot Roast');
assert.equal(pickRecipeTitle({ ogTitle: 'OG Title | Site', h1: 'H1 Title' }), 'H1 Title', 'the first h1 beats og:title');
assert.equal(pickRecipeTitle({ pageTitle: 'Perfect Pot Roast Recipe | Ree Drummond | Food Network' }), 'Perfect Pot Roast');
assert.equal(pickRecipeTitle({ h1: 'serves 2', ogTitle: 'Instagram', pageTitle: 'Threads' }), '');
assert.equal(parseRecipeCaption('Brown it.\nAdd the onions and cook until soft.\n1 lb beef\n2 onions\nMethod:\nBrown it.\nAdd the onions.', {}).title, '', 'instruction sentences are never titles');
const headerLogoHtml = '<html><head><title>Fixture Table</title><meta property="og:title" content="Fixture Table"></head><body><header><h1>Fixture Table</h1></header><main><h1>Lemon Bars</h1><h2>Ingredients</h2><p>1 lemon</p><h2>Method</h2><p>Zest it.</p></main></body></html>';
assert.equal(extractRecipeFromHtml(headerLogoHtml, exampleUrl).chosen.draft.title, 'Lemon Bars', 'an h1 inside <header> is the site name, not the recipe');

// ---------------------------------------------------------------------------
// Second-pass audit: alternate views, reader order, budget accounting
// ---------------------------------------------------------------------------

const alternatesHtml = await readFixture('recipe-alternates.html');
const ampHtml = await readFixture('recipe-alternates-amp.html');
const emptyPage = (title) => `<html><head><title>${title}</title></head><body><p>Nothing here.</p></body></html>`;
const alternatesMock = mockFetch([
  ['https://hearth.example.com/skillet-cornbread', (url) => page(alternatesHtml, url.href)],
  ['https://hearth.example.com/skillet-cornbread/', (url) => page(emptyPage('Canonical'), url.href)],
  ['https://hearth.example.com/skillet-cornbread/print/', (url) => page(emptyPage('Print'), url.href)],
  ['https://hearth.example.com/skillet-cornbread/amp/', (url) => page(ampHtml, url.href)],
]);
const alternatesResult = await processImportRequest({ version: 1, jobId: 'alt-001', createdAt: NOW(), url: 'https://hearth.example.com/skillet-cornbread' }, { now: NOW, fetchText: alternatesMock.fetchText });
assert.equal(alternatesResult.status, 'success');
assert.equal(alternatesResult.provider, 'schema-org', 'structured data from the AMP page beats the page text');
assert.deepEqual(alternatesMock.calls.map((call) => call.href), [
  'https://hearth.example.com/skillet-cornbread', 'https://hearth.example.com/skillet-cornbread/',
  'https://hearth.example.com/skillet-cornbread/print/', 'https://hearth.example.com/skillet-cornbread/amp/',
], 'canonical, then the print link, then AMP; the reader is not needed');
assert.equal(alternatesResult.draft.sourceURL, 'https://hearth.example.com/skillet-cornbread', 'the requested URL stays the source');
assert.equal(alternatesResult.draft.ingredients.length, 4);
assert.equal(alternatesResult.draft.instructions.length, 3);
assert.deepEqual(alternatesResult.sourcesChecked.map((source) => source.label), ['Recipe page on hearth.example.com', 'Canonical page on hearth.example.com', 'Print view on hearth.example.com', 'AMP page on hearth.example.com']);
assertClientSourceContract(alternatesResult, 'https://hearth.example.com/skillet-cornbread');

const readerLastMock = mockFetch([
  ['https://hearth.example.com/skillet-cornbread', (url) => page(alternatesHtml, url.href)],
  [/hearth\.example\.com\/skillet-cornbread\/(?:print\/|amp\/)?$/, (url) => page(emptyPage('Empty'), url.href)],
  ['https://r.jina.ai/https://hearth.example.com/skillet-cornbread', (url) => ({ status: 200, headers: {}, body: readerPage.replace(/Smoky Chipotle Black Bean Tacos/g, 'Skillet Cornbread'), url })],
]);
const readerLastResult = await processImportRequest({ version: 1, jobId: 'alt-002', createdAt: NOW(), url: 'https://hearth.example.com/skillet-cornbread' }, { now: NOW, fetchText: readerLastMock.fetchText });
assert.equal(readerLastResult.status, 'success');
assert.equal(readerLastResult.provider, 'public-reader');
assert.equal(readerLastMock.calls.length, 5, 'the public reader is the last fallback');
assert.equal(readerLastMock.calls.at(-1).href, 'https://r.jina.ai/https://hearth.example.com/skillet-cornbread');
const excludedAlternatesMock = mockFetch([
  [/eatingwell\.com\/recipe\/1\/$/, (url) => page(alternatesHtml.replace(/hearth\.example\.com/g, 'www.eatingwell.com'), url.href)],
  [/eatingwell\.com/, (url) => page(emptyPage('Empty'), url.href)],
]);
const excludedAlternatesResult = await processImportRequest({ version: 1, jobId: 'alt-003', createdAt: NOW(), url: 'https://www.eatingwell.com/recipe/1/' }, { now: NOW, fetchText: excludedAlternatesMock.fetchText });
assert.equal(excludedAlternatesResult.status, 'partial');
assert.ok(excludedAlternatesMock.calls.every((call) => !/r\.jina\.ai/.test(call.href)), 'known-excluded publishers never reach the reader');

const videoLinksEmbed = embedHtml
  .replace(/<div class="Caption">[\s\S]*?<div class="CaptionComments">/, '<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/avery.kitchen/">avery.kitchen</a><br />Lemony sheet-pan chicken tonight! Watch: https://www.youtube.com/watch?v=abc https://vimeo.com/123 https://muse.ai/v/abc123 https://open.spotify.com/episode/x https://podcasts.apple.com/us/podcast/x Full recipe: https://recipes.example.com/lemon-chicken<div class="CaptionComments">')
  .replace(/<script nonce[\s\S]*?<\/script>/, '');
const videoMock = mockFetch([
  [/instagram\.com\/p\/ABC123\/embed/, (url) => page(videoLinksEmbed, url.href)],
  ['https://r.jina.ai/https://www.instagram.com/avery.kitchen/', async (url) => ({ status: 200, headers: {}, body: await readFixture('instagram-profile-reader.json'), url })],
  ['https://recipes.example.com/lemon-chicken', (url) => page(html, url.href)],
]);
const videoResult = await processImportRequest({ ...request, jobId: 'fixture-job-video' }, { now: NOW, fetchText: videoMock.fetchText });
assert.equal(videoResult.status, 'success');
assert.equal(videoResult.provider, 'linked-recipe');
assert.ok(videoMock.calls.every((call) => !/youtube|vimeo|muse\.ai|spotify|podcasts\.apple/.test(call.href)), 'video, audio and app hosts are never crawled');

const partialPage = (url) => page(`<html><head><title>Partial</title><link rel="canonical" href="${url.origin}/canonical/"><link rel="amphtml" href="${url.origin}/amp/"></head><body><h1>Partial Loaf</h1><p>Ingredients: 2 cups flour, 1 egg</p><a href="${url.origin}/print/">Print</a></body></html>`, url.href);
const budgetEmbed = embedHtml
  .replace(/<div class="Caption">[\s\S]*?<div class="CaptionComments">/, `<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/fixture.cook/">fixture.cook</a><br />Partial loaf<br />Ingredients:<br />2 cups flour<br />1 egg<br />${[1, 2, 3, 4, 5, 6].map((n) => `https://blog${n}.example.com/r${n}`).join(' ')}<div class="CaptionComments">`)
  .replace(/<script nonce[\s\S]*?<\/script>/, '');
const budgetMock = mockFetch([
  [/instagram\.com\/p\/BUDGET1\/embed/, (url) => page(budgetEmbed, url.href)],
  ['https://r.jina.ai/https://www.instagram.com/fixture.cook/', (url) => ({ status: 200, headers: {}, body: JSON.stringify({ data: { content: '', metadata: {} } }), url })],
  [/blog\d\.example\.com/, (url) => partialPage(url)],
]);
const budgetResult = await processImportRequest({ version: 1, jobId: 'budget-001', createdAt: NOW(), url: 'https://www.instagram.com/reel/BUDGET1/' }, { now: NOW, fetchText: budgetMock.fetchText });
assert.equal(budgetResult.status, 'partial');
assert.equal(budgetMock.calls.length, 12, 'the request budget is twelve');
assert.equal(budgetResult.sourcesChecked.length, budgetMock.calls.length, 'every source listed as checked was actually fetched');
assert.ok(!budgetResult.sourcesChecked.some((source) => /blog[456]/.test(source.url)), 'pages the budget never reached are not listed');
assertClientSourceContract(budgetResult, 'https://www.instagram.com/reel/BUDGET1/');

// ---------------------------------------------------------------------------
// Second-pass audit: transport (truncation, insecure redirects, deadlines, caps)
// ---------------------------------------------------------------------------

const incompressible = randomBytes(200_000);
const lenient = await decodeResponseBodyLenient(zlib.gzipSync(incompressible), { 'content-encoding': 'gzip' }, 50_000);
assert.deepEqual([lenient.body.length, lenient.truncated, lenient.error], [50_000, true, null], 'the decompressed cap cuts instead of rejecting');
const cutInput = await decodeResponseBodyLenient(zlib.gzipSync(incompressible).subarray(0, 60_000), { 'content-encoding': 'gzip' }, MAX_RESPONSE_BYTES, true);
assert.ok(cutInput.body.length > 10_000 && cutInput.truncated && !cutInput.error, 'a stream cut at the byte cap still yields its decoded prefix');
assert.equal(MAX_RESPONSE_BYTES, 4 * 1024 * 1024);
assert.equal(READER_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
const truncatedFetch = await fetchWithFallbacks('https://example.com/big', { transport: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html), truncated: true }), resolver });
assert.deepEqual([truncatedFetch.status, truncatedFetch.truncated], [200, true]);
const truncatedComplete = await processImportRequest({ version: 1, jobId: 'big-001', createdAt: NOW(), url: 'https://recipes.example.com/post' }, { now: NOW, fetchText: async (url) => ({ ...page(html, url), truncated: true }) });
assert.equal(truncatedComplete.status, 'success');
assert.ok(!truncatedComplete.warnings.some((warning) => /larger than/.test(warning)), 'a complete recipe from the first 4 MB needs no warning');
const truncatedPartial = await processImportRequest({ version: 1, jobId: 'big-002', createdAt: NOW(), url: 'https://www.allrecipes.com/recipe/9/partial/' }, { now: NOW, fetchText: async (url) => ({ ...page(partialHtml, url), truncated: true }) });
assert.equal(truncatedPartial.status, 'partial');
assert.ok(truncatedPartial.warnings.some((warning) => /larger than the importer reads/.test(warning)));
const caps = {};
const deadlines = [];
await processImportRequest({ version: 1, jobId: 'cap-001', createdAt: NOW(), url: 'https://app.example.recipes/r/smoky-chipotle-black-bean-tacos' }, { now: NOW, fetchText: async (url, options) => {
  caps[String(url)] = options.maxBytes;
  deadlines.push(options.deadline);
  return String(url).startsWith('https://r.jina.ai/') ? { status: 200, headers: {}, body: readerPage, url } : page(clientHtml, url);
} });
assert.equal(caps['https://app.example.recipes/r/smoky-chipotle-black-bean-tacos'], MAX_RESPONSE_BYTES);
assert.equal(caps['https://r.jina.ai/https://app.example.recipes/r/smoky-chipotle-black-bean-tacos'], READER_MAX_RESPONSE_BYTES, 'the reader gets the 2 MB cap');
assert.ok(deadlines.every((deadline) => Number.isFinite(deadline) && deadline <= Date.now() + 40_000), 'every fetch carries an absolute deadline');

const insecure = fakeTransport([{ status: 301, headers: { location: 'http://example.com/a' }, body: '' }, { status: 301, headers: { location: 'http://example.com/a' }, body: '' }]);
await assert.rejects(fetchWithFallbacks('https://example.com/start', { transport: insecure.transport, resolver }), (error) => error.message === INSECURE_PAGE_MESSAGE);
assert.equal(insecure.calls.length, 2, 'one https retry of the http target, then stop');
const slowResolver = () => new Promise((resolve) => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 400));
const deadlineStart = Date.now();
await assert.rejects(fetchWithFallbacks('https://example.com/slow', { transport: fakeTransport([{ status: 200, body: okHtml }]).transport, resolver: slowResolver, deadline: Date.now() + 250 }), /timed out/);
assert.ok(Date.now() - deadlineStart < 2_000, 'DNS time counts against the deadline');
const hopTimeouts = [];
await fetchWithFallbacks('https://example.com/ok', { transport: async (_url, options) => { hopTimeouts.push(options.timeoutMs); return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(okHtml) }; }, resolver, deadline: Date.now() + 1_500 });
assert.ok(hopTimeouts[0] <= 1_500 && hopTimeouts[0] > 1_000, `per-hop timeout = min(request timeout, deadline - now): ${hopTimeouts[0]}`);

// ---------------------------------------------------------------------------
// Second-pass audit: hero images
// ---------------------------------------------------------------------------

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
assert.equal(sniffImageType(tinyPng), 'png');
const imageCalls = [];
const embeddedResult = await processImportRequest({ version: 1, jobId: 'img-001', createdAt: NOW(), url: 'https://recipes.example.com/post' }, {
  now: NOW,
  fetchText: async (url) => page(html, url),
  fetchBinary: async (url, options) => { imageCalls.push({ href: String(url), profile: options.profile, maxBytes: options.maxBytes }); return { status: 200, headers: { 'content-type': 'image/png' }, bytes: tinyPng, url }; },
});
assert.equal(embeddedResult.status, 'success');
assert.equal(embeddedResult.draft.heroImage, `data:image/png;base64,${tinyPng.toString('base64')}`);
assert.match(embeddedResult.draft.heroImage, /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'the shape the app validator accepts');
assert.deepEqual(imageCalls, [{ href: 'https://images.example.com/chicken.jpg', profile: 'image', maxBytes: MAX_HERO_IMAGE_BYTES + 1 }], 'one image request');
const bigImage = await processImportRequest({ version: 1, jobId: 'img-002', createdAt: NOW(), url: 'https://recipes.example.com/post' }, { now: NOW, fetchText: async (url) => page(html, url), fetchBinary: async (url) => ({ status: 200, headers: { 'content-type': 'image/jpeg' }, bytes: Buffer.alloc(MAX_HERO_IMAGE_BYTES + 1, 0xff), truncated: true, url }) });
assert.equal(bigImage.draft.heroImage, 'https://images.example.com/chicken.jpg', 'an image over 600 KB stays a hotlink');
const wrongType = await processImportRequest({ version: 1, jobId: 'img-003', createdAt: NOW(), url: 'https://recipes.example.com/post' }, { now: NOW, fetchText: async (url) => page(html, url), fetchBinary: async (url) => ({ status: 200, headers: { 'content-type': 'image/gif' }, bytes: Buffer.from('GIF89a'), url }) });
assert.equal(wrongType.draft.heroImage, 'https://images.example.com/chicken.jpg', 'only JPEG, PNG and WebP are embedded');
const failingImage = await processImportRequest({ version: 1, jobId: 'img-004', createdAt: NOW(), url: 'https://recipes.example.com/post' }, { now: NOW, fetchText: async (url) => page(html, url), fetchBinary: async () => { throw new Error('image down'); } });
assert.deepEqual([failingImage.status, failingImage.draft.heroImage], ['success', 'https://images.example.com/chicken.jpg'], 'an image failure never fails the import');
const sniffedImage = await processImportRequest({ version: 1, jobId: 'img-005', createdAt: NOW(), url: 'https://recipes.example.com/post' }, { now: NOW, fetchText: async (url) => page(html, url), fetchBinary: async (url) => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, bytes: tinyPng, url }) });
assert.match(sniffedImage.draft.heroImage, /^data:image\/png;base64,/, 'the type is sniffed from the bytes when the server mislabels it');
const instagramImageCalls = [];
const instagramImageHtml = html.replace('https://images.example.com/chicken.jpg', 'https://scontent-lax3-1.cdninstagram.com/v/t51.2885-15/photo.jpg');
const instagramImage = await processImportRequest({ version: 1, jobId: 'img-006', createdAt: NOW(), url: 'https://recipes.example.com/post' }, { now: NOW, fetchText: async (url) => page(instagramImageHtml, url), fetchBinary: async (url) => { instagramImageCalls.push(String(url)); throw new Error('never'); } });
assert.equal(instagramImageCalls.length, 0, 'Instagram CDN images are never fetched');
assert.equal(instagramImage.draft.heroImage, 'https://scontent-lax3-1.cdninstagram.com/v/t51.2885-15/photo.jpg');
assert.equal(embedResult.draft.heroImage, null, 'caption imports still carry no Instagram image');

// ---------------------------------------------------------------------------
// Second-pass audit: client limits
// ---------------------------------------------------------------------------

const hugeRecipe = {
  '@type': 'Recipe',
  name: 'Very long title '.repeat(200),
  description: 'd'.repeat(30_000),
  author: { '@type': 'Person', name: 'a'.repeat(900) },
  recipeCuisine: 'c'.repeat(900),
  keywords: Array.from({ length: 150 }, (_, index) => `k${index}`),
  recipeIngredient: [`1 cup ${'x'.repeat(2_500)}`, ...Array.from({ length: 600 }, (_, index) => `${index + 1} cups item${index}`)],
  recipeInstructions: [{ '@type': 'HowToStep', text: `Long step ${'y'.repeat(15_000)}` }, ...Array.from({ length: 600 }, (_, index) => ({ '@type': 'HowToStep', text: `Step text ${index}.` }))],
};
const hugeHtml = `<html><head><title>Huge</title><script type="application/ld+json">${JSON.stringify(hugeRecipe)}</script></head><body></body></html>`;
const hugeResult = await processImportRequest({ version: 1, jobId: 'huge-001', createdAt: NOW(), url: 'https://recipes.example.com/huge' }, { now: NOW, fetchText: async (url) => page(hugeHtml, url) });
assert.equal(hugeResult.status, 'success');
assert.ok(hugeResult.draft.title.length <= 1_000 && hugeResult.draft.description.length <= 20_000, 'title and description');
assert.ok(hugeResult.draft.author.length <= 500 && hugeResult.draft.cuisine.length <= 500 && hugeResult.draft.sourceName.length <= 500, 'short text fields');
assert.ok(hugeResult.draft.tags.length <= 100 && hugeResult.draft.tags.every((tag) => tag.length <= 500), 'tags');
assert.equal(hugeResult.draft.ingredients.length, 500);
assert.equal(hugeResult.draft.instructions.length, 500);
assert.ok(hugeResult.draft.ingredients.every((item) => item.rawText.length <= 2_000 && item.ingredientName.length <= 500 && item.normalizedIngredient.length <= 500), 'ingredient fields');
assert.ok(hugeResult.draft.instructions.every((step, index) => step.text.length <= 10_000 && step.stepNumber === index + 1), 'instruction fields');
assertValidDraft(hugeResult.draft);
assert.ok(hugeResult.sourcesChecked.length <= 20 && hugeResult.warnings.length <= 50 && hugeResult.warnings.every((warning) => warning.length <= 500));
const clamped = clampDraftToClientLimits({
  title: 'x'.repeat(2_000), description: '', notes: '', author: null, cuisine: null, sourceName: 's', categories: [], tags: [], ingredients: [],
  instructions: [{ id: 's', stepNumber: 7, section: null, text: 't'.repeat(20_000), timerMinutes: null }],
  sourceLinks: Array.from({ length: 25 }, (_, index) => ({ kind: 'recipe-page', url: `https://x.example.com/${index}`, label: 'l'.repeat(600) })),
});
assert.deepEqual([clamped.title.length, clamped.instructions[0].text.length, clamped.instructions[0].stepNumber, clamped.sourceLinks.length, clamped.sourceLinks[0].label.length], [1_000, 10_000, 1, 20, 500]);

// ---------------------------------------------------------------------------
// Review follow-ups: ingredient groups, WordPress titles, post wrappers, meta lines
// ---------------------------------------------------------------------------

const toServe = parseRecipeCaption('Chicken Tacos\nIngredients:\n1 lb chicken\n2 limes\nTo serve:\nLime wedges\nFresh cilantro\n1 cup sour cream\nMethod:\nCook.\nServe.', {});
assert.deepEqual(toServe.ingredients.map((item) => [item.rawText, item.section]), [['1 lb chicken', null], ['2 limes', null], ['Lime wedges', 'To serve'], ['Fresh cilantro', 'To serve'], ['1 cup sour cream', 'To serve']], '"To serve:" heads an ingredient group, not the notes');
assert.deepEqual([toServe.notes, toServe.instructions.length], ['', 2]);
const serveWith = parseRecipeCaption('Chicken Tacos\nIngredients:\n1 lb chicken\nServe with: 2 limes, 1 cup rice\nOptional: 1 tsp chili flakes\nMethod:\nCook.', {});
assert.deepEqual(serveWith.ingredients.map((item) => [item.rawText, item.section, item.optional]), [['1 lb chicken', null, false], ['2 limes', 'Serve with', false], ['1 cup rice', 'Serve with', false], ['1 tsp chili flakes, optional', 'Serve with', true]], 'an inline group heading keeps its items');
assert.equal(serveWith.notes, '');
assert.equal(parseRecipeCaption('Pot Roast\nIngredients:\n1 roast\nMethod:\nBrown it.\nServing suggestions\nMashed potatoes go well.', {}).notes, 'Mashed potatoes go well.', '"Serving suggestions" still ends the method');

const wordpressHtml = await readFixture('recipe-wordpress-entry-header.html');
const wordpressMock = mockFetch([[/r\.jina\.ai/, () => { throw new Error('HTTP 429'); }], [/pinchoffixture\.com/, (url) => page(wordpressHtml, url.href)]]);
const wordpressResult = await processImportRequest({ version: 1, jobId: 'wp-001', createdAt: NOW(), url: 'https://pinchoffixture.com/pot-roast/' }, { now: NOW, fetchText: wordpressMock.fetchText });
assert.deepEqual([wordpressResult.status, wordpressResult.provider, wordpressResult.draft.title], ['success', 'text-parser', 'Pot Roast'], 'the h1 inside <article><header class="entry-header"> is the recipe title, not the site name');
assert.deepEqual(wordpressResult.draft.ingredients.map((item) => item.rawText), ['1 chuck roast (about 3 pounds)', '2 onions, quartered', '4 carrots, cut into 2-inch pieces', '2 cups beef broth', 'Salt and pepper']);
assert.deepEqual(wordpressResult.draft.instructions.map((step) => step.text), ['Brown the roast on all sides.', 'Add the onions, carrots and broth.', 'Cover and braise for 3 hours.', 'Serve immediately.'], 'an Elementor post wrapper tagged "cookies" keeps its content and "Serve immediately." is a step');
assert.equal(wordpressResult.draft.notes, 'Leftovers keep for 3 days.');
assert.equal(wordpressMock.calls.length, 1, 'a complete text result never needs the reader');
assert.ok(!/Facebook|Pinterest|Share on X|Beef Stew|Loved it|Sign me up|We use cookies|supported by readers|Calories/.test(JSON.stringify(wordpressResult.draft)));
assertValidDraft(wordpressResult.draft);
const wordpressText = htmlToText(wordpressHtml);
assert.ok(/1 chuck roast/.test(wordpressText) && !/Facebook|Beef Stew|Loved it|Sign me up|We use cookies|supported by readers|Recipes/.test(wordpressText), wordpressText);
assert.equal(extractRecipeFromHtml('<html><head><title>Pot Roast - Pinch of Yum</title><meta property="og:title" content="Pot Roast - Pinch of Yum"><meta property="og:site_name" content="Pinch of Yum"></head><body><article><header class="entry-header"><h1 class="entry-title">Pot Roast</h1></header><div class="entry-content"><h2>Ingredients</h2><p>1 roast</p><p>2 onions</p><h2>Instructions</h2><p>Brown the roast.</p><p>Braise for 3 hours.</p></div></article></body></html>', new URL('https://pinchofyum.com/pot-roast/')).chosen.draft.title, 'Pot Roast');
assert.equal(pickRecipeTitle({ ogTitle: 'Pot Roast - Pinch of Yum' }), 'Pot Roast', 'the trailing part is the site suffix even when it is longer');
assert.equal(pickRecipeTitle({ ogTitle: 'Easy Pasta | My Delicious Kitchen Blog' }), 'Easy Pasta');
assert.equal(pickRecipeTitle({ h1: 'Pinch of Yum', ogTitle: 'Pot Roast - Pinch of Yum', hostname: 'www.pinchofyum.com' }), 'Pot Roast', 'an h1 equal to the host name is the logo');
assert.equal(pickRecipeTitle({ pageTitle: 'Pinch of Yum | Pot Roast', hostname: 'pinchofyum.com' }), 'Pot Roast', 'a site-name prefix is dropped when the host name identifies it');
assert.equal(pickRecipeTitle({ pageTitle: 'White Chicken Chili Recipe - NYT Cooking', siteName: 'NYT Cooking', hostname: 'cooking.nytimes.com' }), 'White Chicken Chili');
assert.equal(pickRecipeTitle({ ogTitle: 'Pinch of Yum', siteName: 'Pinch of Yum' }), '', 'a title that is only the site name is no title');
for (const title of ['Roast the Chicken', 'Bake with Love Cookies', 'Turn Over Pastries', 'Make It Yourself Granola', 'Time-Saving Pasta', 'Level Up Lasagna']) {
  assert.equal(pickRecipeTitle({ h1: title }), title, `a page h1 may start with a cooking verb or a card label: ${title}`);
}
for (const title of ['Brown it', 'Brown it.', 'Mix well', 'Set aside.', 'serves 2', 'Cook time: 20 minutes', 'Prep Time 10 minutes']) {
  assert.equal(pickRecipeTitle({ h1: title }), '', `never a title: ${title}`);
}
assert.equal(pickRecipeTitle({ fallback: 'Roast the Chicken' }), '', 'free-text fallbacks keep the strict caption rules');

assert.deepEqual(parseRecipeCaption('Pasta\nIngredients:\n1 lb pasta\nDirections:\nBoil the pasta.\nToss with sauce.\nServe immediately.', {}).instructions.map((step) => step.text), ['Boil the pasta.', 'Toss with sauce.', 'Serve immediately.']);
assert.deepEqual(parseRecipeCaption('Tacos\nIngredients:\n1 lb chicken\nMethod:\nCook the chicken.\nServe with rice.\nSeason to taste.\nCool completely.\nTime to eat!\nLevel the batter.\nCook 2 minutes per side.', {}).instructions.map((step) => step.text), ['Cook the chicken.', 'Serve with rice.', 'Season to taste.', 'Cool completely.', 'Time to eat!', 'Level the batter.', 'Cook 2 minutes per side.'], 'unnumbered steps starting with Cook/Serve/Time/Level survive');
const metaLines = parseRecipeCaption('Pasta\nServes 4\nPrep time: 10 minutes\nCook Time 20 minutes\nTotal: 30 min\nCalories: 350\nCourse: Main\nLevel Easy\nIngredients:\n1 lb pasta\nServes four\nDirections:\nBoil it.', {});
assert.deepEqual([metaLines.description, metaLines.ingredients.map((item) => item.rawText), metaLines.servings, metaLines.prepTime, metaLines.cookTime], ['', ['1 lb pasta'], 4, 10, 20], 'card fields with values are still skipped everywhere');

for (const [line, expected] of [['Seven-spice blend', [null, 'Seven-spice blend']], ['One-pot pasta seasoning', [null, 'One-pot pasta seasoning']], ['Two-ingredient dough', [null, 'Two-ingredient dough']], ['Five spice powder', [null, 'Five spice powder']], ['Ten minute marinade', [null, 'Ten minute marinade']], ['One egg', [{ numerator: 1, denominator: 1 }, 'egg']], ['Two lemons', [{ numerator: 2, denominator: 1 }, 'lemons']]]) {
  const parsed = parseIngredient(line);
  assert.deepEqual([parsed.quantity, parsed.ingredientName], expected, line);
}
assert.equal(parseIngredient('Five spice powder').groceryCategory, 'Spices & Seasonings');

assert.deepEqual(parseRecipeCaption('Soup\nIngredients:\n1 onion, 1/2 inch dice\n2 carrots, 1 cm slices\n3 potatoes, 2-inch chunks\nMethod:\nCook.', {}).ingredients.map((item) => item.rawText), ['1 onion, 1/2 inch dice', '2 carrots, 1 cm slices', '3 potatoes, 2-inch chunks'], 'size clauses never become ingredients');
assert.deepEqual(parseRecipeCaption('Soup\nIngredients:\n1 onion\n2 carrots, 1 potato\nMethod:\nCook.', {}).ingredients.map((item) => item.rawText), ['1 onion', '2 carrots, 1 potato'], 'two parts split only when the line is the whole list');
assert.deepEqual(parseRecipeCaption('Soup\nIngredients:\n1 onion, 2 carrots\nMethod:\nCook.', {}).ingredients.map((item) => item.rawText), ['1 onion', '2 carrots']);
assert.deepEqual(parseRecipeCaption('Soup\nIngredients:\n1 onion\n2 carrots, 1 potato, 2 tbsp oil\nMethod:\nCook.', {}).ingredients.map((item) => item.rawText), ['1 onion', '2 carrots', '1 potato', '2 tbsp oil'], 'three or more quantified parts always split');

assert.deepEqual(draftFromSchemaRecipe({ '@type': 'Recipe', name: 'X', recipeInstructions: { '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', position: 1, item: 'Preheat oven.' }, { '@type': 'ListItem', position: 2, item: 'Bake.' }] } }, exampleUrl).instructions.map((step) => step.text), ['Preheat oven.', 'Bake.'], 'a ListItem whose item is a plain string');

const noHeadingList = parseRecipeCaption('Garlic Bread\n1. 1 loaf bread\n2. 2 tbsp butter\n3. 2 cloves garlic\nMethod:\nBake.', {});
assert.deepEqual([noHeadingList.title, noHeadingList.ingredients.map((item) => item.rawText), noHeadingList.instructions.map((step) => step.text)], ['Garlic Bread', ['1 loaf bread', '2 tbsp butter', '2 cloves garlic'], ['Bake.']], 'a numbered ingredient list needs no heading');
const numberedSteps = parseRecipeCaption('Pancakes\n1. 2 minutes later, flip them.\n2. Cook until golden.', {});
assert.deepEqual([numberedSteps.ingredients.length, numberedSteps.instructions.at(-1)?.text], [0, 'Cook until golden.'], 'a lone numbered line that merely starts with a number never opens an ingredient block');

const importerSource = await fs.readFile(path.join(directory, 'process-recipe-imports.mjs'), 'utf8');
assert.ok(!/[   ﻿️‍​⃣]/.test(importerSource), 'the importer source spells invisible characters as escapes');

const readerCut = JSON.stringify({ data: { title: 'Rice Bowl | Hearth', content: '# Rice Bowl\n\n## Ingredients\n\n* 1 cup rice\n* 2 cups water', metadata: {} } });
const readerCutResult = await processImportRequest({ version: 1, jobId: 'cut-001', createdAt: NOW(), url: 'https://hearth.example.com/rice-bowl' }, {
  now: NOW,
  fetchText: async (url) => (String(url).startsWith('https://r.jina.ai/') ? { status: 200, headers: {}, body: readerCut, url: new URL(url), truncated: true } : page(emptyPage('Rice Bowl | Hearth'), url)),
});
assert.equal(readerCutResult.status, 'partial');
assert.ok(readerCutResult.warnings.some((warning) => warning === 'The readable copy of the page was larger than the importer reads (2 MB); only its first part was parsed.'), readerCutResult.warnings.join(' | '));

// ---------------------------------------------------------------------------
// Second-pass audit: queue run budget and CLI arguments
// ---------------------------------------------------------------------------

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'savor-import-'));
const requestDirectory = path.join(tmpRoot, 'savor', 'v1', 'imports', 'requests');
await fs.mkdir(requestDirectory, { recursive: true });
for (const name of ['a', 'b']) await fs.writeFile(path.join(requestDirectory, `${name}.json`), JSON.stringify({ version: 1, jobId: name, createdAt: NOW(), url: 'http://example.com/insecure' }));
const neverFetch = async () => { throw new Error('must not fetch'); };
const deferredSummary = await processPendingRequests({ root: tmpRoot, maxJobs: 10, maxRunMs: 0, fetchText: neverFetch, now: NOW });
assert.deepEqual(deferredSummary, { processed: 0, success: 0, partial: 0, failed: 0, deferred: 2, results: [] }, 'past the run budget nothing more is dequeued');
const runSummary = await processPendingRequests({ root: tmpRoot, maxJobs: 10, fetchText: neverFetch, now: NOW });
assert.deepEqual([runSummary.processed, runSummary.failed, runSummary.deferred], [2, 2, 0]);
const writtenResult = JSON.parse(await fs.readFile(path.join(tmpRoot, 'savor', 'v1', 'imports', 'results', 'a.json'), 'utf8'));
assert.deepEqual([writtenResult.status, writtenResult.importerVersion, writtenResult.jobId], ['error', IMPORTER_VERSION, 'a']);
await fs.rm(tmpRoot, { recursive: true, force: true });
assert.equal(parseArguments(['--root', '.', '--max-jobs', '20', '--max-run-minutes', '15']).maxRunMs, 15 * 60_000);
assert.equal(parseArguments([]).maxRunMs, DEFAULT_MAX_RUN_MS);
assert.throws(() => parseArguments(['--max-run-minutes', '0']));
assert.throws(() => parseArguments(['--max-jobs', '101']));

console.log('Recipe import processor fixture tests passed.');

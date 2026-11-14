import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRecipeAccessGate } from './recipe-access.mjs';

test('recognizes the public Substack recipe preview without treating its prose as a recipe', () => {
  const preview = '<article><h1>Chipotle lime shredded beef chili</h1><p>Serves 6 to 8</p><p>Ingredients:</p>'
    + '<div class="paywall" data-testid="paywall" role="region" aria-label="Paywall">'
    + '<h2>Continue reading this post for free, courtesy of Caroline Chambers.</h2>'
    + '<button>Claim my free post</button><a>Or purchase a paid subscription.</a></div></article>';
  assert.equal(hasRecipeAccessGate(preview), true);
});

test('recognizes each explicit visible HTML access marker', () => {
  for (const attr of ['class="notice paywall padded"', 'data-testid="paywall"', "aria-label='Paywall'", 'data-component-name=Paywall']) {
    assert.equal(hasRecipeAccessGate(`<div ${attr}>Content requires access</div>`), true, attr);
  }
});

test('recognizes rendered access messages, including free-post claims', () => {
  for (const text of [
    'Ingredients:\nContinue reading this post for free, courtesy of the creator.\nClaim my free post\nOr purchase a paid subscription.',
    'This post is for paid subscribers.',
    'This recipe is available for premium members.',
    'This post is only available to paid subscribers.',
    'Subscribe to keep reading.',
    'Sign in to view this recipe.',
    'Log in to read the full article.',
    '<p>This post is for <strong>paid subscribers</strong>.</p>',
  ]) assert.equal(hasRecipeAccessGate(text), true, text);
});

test('does not classify ordinary newsletter and account links as access gates', () => {
  for (const text of [
    '<article><h1>Bean soup</h1><p>Ingredients: 2 cups beans</p><p>Simmer for 20 minutes.</p></article><footer>Subscribe to our newsletter for more recipes. Already a subscriber? Sign in.</footer>',
    'Get new recipes in your inbox. Subscribe for free.',
    'Continue reading this post for free. Here are the ingredients and instructions.',
    '<div class="paywall-unlock-avatar">Author portrait</div><p>Subscribe for updates.</p>',
    '<script type="application/ld+json">{"isAccessibleForFree":false}</script><p>The entire recipe is publicly visible.</p>',
    '', null, undefined,
  ]) assert.equal(hasRecipeAccessGate(text), false, String(text));
});

test('ignores paywall templates, script strings, comments, and hidden subtrees', () => {
  const marker = '<div class="paywall">This post is for paid subscribers.</div>';
  for (const hidden of [
    `<script>const template = ${JSON.stringify(marker)};</script>`,
    `<section><script>const template = ${JSON.stringify(`</section>${marker}`)};</script></section>`,
    `<template><section><template>${marker}</template>${marker}</section></template>`,
    `<!-- ${marker} -->`,
    `<div hidden>${marker}</div>`,
    `<section aria-hidden="true"><div>${marker}</div></section>`,
    `<div style="color: red; display: none !important">${marker}</div>`,
    `<div style="visibility: hidden;">${marker}</div>`,
    `<head><title>This post is for paid subscribers</title></head>`,
  ]) assert.equal(hasRecipeAccessGate(`${hidden}<article>Public bean soup recipe</article>`), false, hidden);
});

test('a hidden template does not hide a separate real gate', () => {
  assert.equal(hasRecipeAccessGate('<template><div class="paywall"></div></template><section aria-label="Paywall">Claim access</section>'), true);
});

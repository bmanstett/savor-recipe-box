import assert from 'node:assert/strict';
import { readSharedRecipeLink, shareShortcutPrefix } from '../lib/share-intake.ts';

const APP = 'https://bmanstett.github.io/savor-recipe-box/';
const RECIPE = 'https://recipes.example.com/lemon-chicken';
const hashShare = (value: string) => `${APP}#share?url=${encodeURIComponent(value)}`;
const queryShare = (key: string, value: string) => `${APP}?${key}=${encodeURIComponent(value)}`;

assert.deepEqual(readSharedRecipeLink(hashShare(RECIPE)), {
  url: RECIPE, hadSharePayload: true, cleanedHref: APP,
});
assert.equal(readSharedRecipeLink(queryShare('url', RECIPE)).url, RECIPE);
assert.equal(readSharedRecipeLink(queryShare('text', `Try this recipe: ${RECIPE}`)).url, RECIPE);
assert.equal(readSharedRecipeLink(queryShare('title', RECIPE)).url, RECIPE);
assert.equal(readSharedRecipeLink(queryShare('url', 'recipes.example.com/pasta')).url, 'https://recipes.example.com/pasta');
assert.equal(readSharedRecipeLink(queryShare('url', '//recipes.example.com/pasta')).url, 'https://recipes.example.com/pasta');
assert.equal(readSharedRecipeLink(queryShare('text', 'recipes.example.com')).url, null, 'a title/domain in prose is not a shared link');
assert.equal(readSharedRecipeLink(queryShare('title', 'Example.com')).url, null);

const complicated = 'https://recipes.example.com/crème_(lemon)?amount=1+2&label=a%26b&name=été#step-3';
const canonicalComplicated = new URL(complicated).href;
assert.equal(readSharedRecipeLink(hashShare(complicated)).url, canonicalComplicated, 'Shortcut encoding preserves &, +, Unicode, parentheses, and recipe anchors');
assert.equal(readSharedRecipeLink(queryShare('url', complicated)).url, canonicalComplicated);
assert.equal(readSharedRecipeLink(`${APP}?url=https%3A%2F%2Frecipes.example.com%2Fpasta%3Famount%3D1+2`).url,
  'https://recipes.example.com/pasta?amount=1+2', 'literal plus in an explicit URL field survives');
assert.equal(readSharedRecipeLink(`${APP}?text=Try+https%3A%2F%2Frecipes.example.com%2Fpasta+today`).url,
  'https://recipes.example.com/pasta', 'text uses form-encoded plus signs as spaces');
assert.equal(readSharedRecipeLink(hashShare('http://recipes.example.com/pasta?x=1&y=2')).url,
  'https://recipes.example.com/pasta?x=1&y=2');
assert.equal(readSharedRecipeLink(hashShare('http://recipes.example.com:80/pasta')).url,
  'https://recipes.example.com/pasta');

for (const wrapped of [`<${RECIPE}>`, `"${RECIPE}"`, `'${RECIPE}'`, `“${RECIPE}”`, `(${RECIPE})`]) {
  assert.equal(readSharedRecipeLink(queryShare('text', wrapped)).url, RECIPE, `unwrap ${wrapped}`);
}
assert.equal(readSharedRecipeLink(queryShare('text', 'Try https://recipes.example.com/cookies_(easy)).')).url,
  'https://recipes.example.com/cookies_(easy)', 'prose closing punctuation is removed but balanced parentheses stay');
assert.equal(readSharedRecipeLink(queryShare('text', 'Make “https://recipes.example.com/pasta” tonight.')).url,
  'https://recipes.example.com/pasta');
assert.equal(readSharedRecipeLink(queryShare('text', '[Recipe](https://recipes.example.com/cookies_(easy)).')).url,
  'https://recipes.example.com/cookies_(easy)');
assert.equal(readSharedRecipeLink(queryShare('text', 'Here is https://recipes.example.com/pasta!')).url,
  'https://recipes.example.com/pasta');
for (const ending of ['.', '!', '?', ',', ';', "'", '(easy)', ')']) {
  const legalUrl = `${RECIPE}${ending}`;
  assert.equal(readSharedRecipeLink(queryShare('url', legalUrl)).url, legalUrl, 'direct URL punctuation must remain intact');
}

for (const unsafe of [
  'javascript:alert(1)',
  'javascript:location="https://recipes.example.com/stolen"',
  '"javascript:location=\'https://recipes.example.com/stolen\'"',
  'data:text/plain,https://recipes.example.com/stolen',
  'ftp://recipes.example.com/pasta',
  'file:///tmp/recipe.html',
  'https://user:password@recipes.example.com/pasta',
  'https://user@recipes.example.com/pasta',
  'https://localhost/pasta',
  'https://foo.localhost/pasta',
  'https://kitchen.local/pasta',
  'https://kitchen.internal/pasta',
  'https://kitchen.home/pasta',
  'https://kitchen.lan/pasta',
  'https://kitchen.invalid/pasta',
  'https://intranet/pasta',
  'https://127.0.0.1/pasta',
  'https://127.1/pasta',
  'https://2130706433/pasta',
  'https://0x7f000001/pasta',
  'https://10.10.0.1/pasta',
  'https://172.16.0.1/pasta',
  'https://192.168.1.1/pasta',
  'https://169.254.169.254/pasta',
  'https://100.64.0.1/pasta',
  'https://0.0.0.0/pasta',
  'https://224.0.0.1/pasta',
  'https://[::1]/pasta',
  'https://[::ffff:127.0.0.1]/pasta',
  'https://[fc00::1]/pasta',
  'https://[fe80::1]/pasta',
  'https://[2001::1234]/pasta',
  'https://[2001:db8::1]/pasta',
  'https://[2002:7f00:1::]/pasta',
  'https://recipes.example.com:8080/pasta',
  `${APP}?url=${encodeURIComponent(RECIPE)}`,
  `${APP}index.html#share?url=${encodeURIComponent(RECIPE)}`,
  `${APP}nested-route`,
  'https://bmanstett.github.io/savor-recipe-box',
]) {
  const result = readSharedRecipeLink(hashShare(unsafe));
  assert.equal(result.url, null, `unsafe/recursive source rejected: ${unsafe}`);
  assert.equal(result.hadSharePayload, true, 'invalid shares still surface an error');
  assert.equal(result.cleanedHref, APP);
}
assert.equal(readSharedRecipeLink(hashShare('https://8.8.8.8/recipe')).url, 'https://8.8.8.8/recipe');
assert.equal(readSharedRecipeLink(hashShare('https://[2606:4700:4700::1111]/recipe')).url,
  'https://[2606:4700:4700::1111]/recipe');
assert.equal(readSharedRecipeLink(hashShare('https://bmanstett.github.io/another-project/recipe')).url,
  'https://bmanstett.github.io/another-project/recipe', 'another project on the same host is not Savor');

const staleQuery = `${APP}?url=${encodeURIComponent('https://recipes.example.com/stale')}`;
assert.equal(readSharedRecipeLink(`${staleQuery}#share?url=${encodeURIComponent(RECIPE)}`).url, RECIPE);
assert.equal(readSharedRecipeLink(`${staleQuery}#share?url=javascript%3Aalert(1)`).url, null,
  'invalid fragment share must not import a stale query URL');
assert.equal(readSharedRecipeLink(`${APP}?url=invalid&text=${encodeURIComponent(`Save ${RECIPE}`)}`).url, RECIPE,
  'valid text is a fallback within the same payload');
assert.deepEqual(readSharedRecipeLink(`${APP}?view=grocery&url=${encodeURIComponent(RECIPE)}&title=Dinner&theme=a%20b&filter=a+b#step-1`), {
  url: RECIPE, hadSharePayload: true,
  cleanedHref: `${APP}?view=grocery&theme=a%20b&filter=a+b#step-1`,
});
assert.deepEqual(readSharedRecipeLink(`${APP}?view=recipes&text=stale#share?url=${encodeURIComponent(RECIPE)}`), {
  url: RECIPE, hadSharePayload: true, cleanedHref: `${APP}?view=recipes`,
});
assert.equal(readSharedRecipeLink(`${APP}?url=invalid&url=${encodeURIComponent(RECIPE)}`).url, RECIPE);
assert.equal(readSharedRecipeLink(`${APP}?%75rl=${encodeURIComponent(RECIPE)}&view=home`).cleanedHref, `${APP}?view=home`);

for (const empty of [`${APP}?url=`, `${APP}?text=`, `${APP}?title=Dinner`, `${APP}#share?`, `${APP}#share?url=%E0%A4%A`]) {
  const result = readSharedRecipeLink(empty);
  assert.equal(result.url, null);
  assert.equal(result.hadSharePayload, true);
  assert.equal(result.cleanedHref, APP);
}
for (const untouched of [APP, `${APP}?capture=1`, `${APP}?view=grocery#recipe-123`, `${APP}#url=${RECIPE}`, `${APP}#Share?url=${RECIPE}`]) {
  assert.deepEqual(readSharedRecipeLink(untouched), { url: null, hadSharePayload: false, cleanedHref: untouched });
}
assert.deepEqual(readSharedRecipeLink('not a URL'), { url: null, hadSharePayload: false, cleanedHref: 'not a URL' });

assert.equal(shareShortcutPrefix(`${APP}?view=grocery#recipe-12`), `${APP}#share?url=`);
assert.equal(shareShortcutPrefix(`${APP}index.html?capture=1#anything`), `${APP}index.html#share?url=`);
assert.equal(shareShortcutPrefix('https://savor.example.com'), 'https://savor.example.com/#share?url=');
assert.equal(shareShortcutPrefix('http://savor.example.com/app/'), 'https://savor.example.com/app/#share?url=');
assert.equal(shareShortcutPrefix('http://localhost:5173/app/?view=home'), 'http://localhost:5173/app/#share?url=');
for (const invalid of ['not a URL', 'javascript:alert(1)', 'file:///app/index.html', 'https://user:password@savor.example.com/', 'https://192.168.1.1/']) {
  assert.equal(shareShortcutPrefix(invalid), '', `invalid app URL rejected: ${invalid}`);
}

console.log('Share intake tests passed.');

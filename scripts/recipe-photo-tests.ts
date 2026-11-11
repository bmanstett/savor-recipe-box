import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { genericRecipePhoto, recipePhotoCandidates, RECIPE_PHOTO_RULES } from '../lib/recipe-photo.ts';

const examples: Array<[string, string]> = [
  ['Grandma’s Blueberry Pancakes', 'fallback-pancakes.jpg'],
  ['Overnight oats with berries', 'fallback-oatmeal.jpg'],
  ['Chicken noodle soup', 'tomato-soup.jpg'],
  ['Salmon tacos', 'chicken-tacos.jpg'],
  ['Sweet chili-lime shrimp', 'fallback-shrimp.jpg'],
  ['Turkey chili', 'fallback-chili.jpg'],
  ['Eggplant Parmesan', 'fallback-vegetables.jpg'],
  ['Cauliflower steaks', 'fallback-vegetables.jpg'],
  ['Scrambled eggs', 'fallback-eggs.jpg'],
  ['Egg rolls', 'fallback-egg-rolls.jpg'],
  ['Crab cakes', 'fallback-crab-cakes.jpg'],
  ['Mac & cheese', 'tuscan-pasta.jpg'],
  ['Chocolate chip cookies', 'fallback-cookies.png'],
  ['Apple pie', 'fallback-pie.jpg'],
  ['Chicken pot pie', 'fallback-casserole.jpg'],
  ['Chocolate mousse', 'fallback-mousse.jpg'],
  ['Banana bread', 'banana-bread.jpg'],
  ['Vegan stir-fry', 'fallback-stir-fry.jpg'],
  ['Pork dumplings', 'fallback-dumplings.jpg'],
  ['Swedish meatballs', 'fallback-meatballs.jpg'],
  ['Crêpes', 'fallback-pancakes.jpg'],
];
for (const [title, filename] of examples) {
  const photo = genericRecipePhoto(title);
  assert.equal(photo.src, `./recipes/${filename}`, title);
  assert.equal(photo.illustrative, true);
}

// A saved source/upload must win; missing, unresolved, or broken images can
// move through the same candidate list without changing household data.
for (const source of ['https://food.example/photo.jpg', 'data:image/jpeg;base64,/9j/', './recipes/lemon-chicken.jpg']) {
  const candidates = recipePhotoCandidates('Pancakes', source);
  assert.equal(candidates[0].src, source);
  assert.equal(candidates[0].illustrative, false);
  assert.equal(candidates[1].src, './recipes/fallback-pancakes.jpg');
}
for (const source of [null, '', 'github-media:savor/v1/media/pending.jpg', 'javascript:alert(1)']) {
  assert.equal(recipePhotoCandidates('Pancakes', source)[0].src, './recipes/fallback-pancakes.jpg');
}
const candidates = recipePhotoCandidates('Bean salad', './recipes/bean-salad.jpg');
assert.equal(candidates.length, 1, 'never retry the same broken URL in a fallback loop');
assert.equal(genericRecipePhoto('Family favorite').src, './recipes/bean-salad.jpg');
assert.equal(genericRecipePhoto('').src, './recipes/bean-salad.jpg');

// Check the actual shipped files and attribution anchors, including png/jpg
// differences that otherwise surface only as broken images on a phone.
const credits = readFileSync(new URL('../public/recipes/photo-credits.html', import.meta.url), 'utf8');
for (const { file } of RECIPE_PHOTO_RULES) {
  assert(existsSync(new URL(`../public/recipes/${file}`, import.meta.url)), `Missing bundled photo: ${file}`);
  if (file.startsWith('fallback-')) {
    const anchor = file.slice(9, -4);
    assert(credits.includes(`id="${anchor}"`), `Missing photo credit: ${anchor}`);
  }
}
console.log(`Recipe photo tests passed (${examples.length} title matches, source priority, fallbacks, assets and credits).`);

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregateRecipes, createBlankDraft, draftToRecipe, formatIngredient, formatQuantityWithUnit, formatRational,
  formatShoppingQuantity, groceryCategoryFor, isIngredientSectionHeading, matchesPantryStaple, normalizeIngredientName,
  parseIngredientLine, parseRecipeText, pluralizeUnit, rational,
} from '../lib/domain.ts';
import { mergeGroceryItems, replaceGeneratedItems } from '../lib/grocery-merge.ts';

/**
 * Mirrors SEED_PREFERENCES.pantryStaples in lib/seed.ts, which Node cannot import directly (it uses extensionless
 * imports). The "source hygiene" scenario below reads seed.ts and fails if the two lists drift apart.
 */
const DEFAULT_STAPLES = ['kosher salt', 'salt', 'black pepper', 'olive oil', 'vegetable oil', 'cooking spray'];
import { buildSundayPrepRecommendation, optimizeMealWeek } from '../lib/meal-week-optimizer.ts';
import { formatSkylightWeek, isValidSkylightDeviceEmail, normalizeSkylightEmailApp, skylightEmailDraftUrl, skylightGmailComposeUrl, skylightMailto } from '../lib/skylight.ts';
import { isImageReference, normalizeImageReference } from '../lib/media-reference.ts';
import { parseRecipeSourceUrl } from '../lib/recipe-source.ts';
import type { Recipe } from '../lib/types.ts';

function recipe(id: string, title: string, lines: string[], servings = 4): Recipe {
  const draft = createBlankDraft('manual');
  draft.id = id;
  draft.title = title;
  draft.servings = servings;
  draft.ingredients = lines.map((line, index) => ({ ...parseIngredientLine(line), id: `${id}_ingredient_${index}` }));
  return draftToRecipe(draft, '2026-08-23T12:00:00.000Z');
}

function itemFor(items: ReturnType<typeof aggregateRecipes>, normalized: string, unit?: string) {
  return items.find((item) => item.normalizedIngredient === normalized && (unit === undefined || item.unit === unit));
}

{
  const items = aggregateRecipes([
    recipe('a', 'A', ['2 onions']),
    recipe('b', 'B', ['1 onion']),
  ]);
  const onion = itemFor(items, 'onion');
  assert(onion, 'onions should aggregate');
  assert.equal(formatRational(onion.quantity), '3');
  assert.equal(onion.unit, 'each');
  assert.equal(onion.recipeContributions.length, 2);
}

{
  const items = aggregateRecipes([
    recipe('a', 'A', ['1 tbsp olive oil']),
    recipe('b', 'B', ['2 tablespoons olive oil']),
  ]);
  const oil = itemFor(items, 'olive oil');
  assert(oil, 'olive oil should aggregate');
  assert.equal(formatRational(oil.quantity), '3');
  assert.equal(oil.unit, 'tbsp');
}

{
  const items = aggregateRecipes([
    recipe('a', 'A', ['1 cup milk']),
    recipe('b', 'B', ['1/2 cup milk']),
  ]);
  const milk = itemFor(items, 'milk');
  assert(milk, 'milk should aggregate');
  assert.equal(formatRational(milk.quantity), '1½');
  assert.equal(milk.unit, 'cup');
}

{
  const items = aggregateRecipes([
    recipe('a', 'A', ['8 oz mozzarella']),
    recipe('b', 'B', ['1 lb mozzarella']),
  ]);
  const cheese = itemFor(items, 'mozzarella');
  assert(cheese, 'mozzarella should aggregate');
  assert.equal(formatRational(cheese.quantity), '1½');
  assert.equal(cheese.unit, 'lb');
}

{
  const items = aggregateRecipes([
    recipe('a', 'A', ['1 red onion']),
    recipe('b', 'B', ['1 yellow onion']),
  ]);
  assert.equal(items.length, 2, 'red and yellow onion must remain separate');
  assert(itemFor(items, 'red onion'));
  assert(itemFor(items, 'yellow onion'));
}

{
  const items = aggregateRecipes([
    recipe('a', 'A', ['500 g flour']),
    recipe('b', 'B', ['1/2 kg flour']),
  ]);
  const flour = itemFor(items, 'flour');
  assert(flour);
  assert.equal(formatRational(flour.quantity), '1');
  assert.equal(flour.unit, 'kg');
}

{
  const scaled = recipe('scaled', 'Scaled', ['2 cups milk'], 4);
  const items = aggregateRecipes([scaled], { scaled: 6 });
  const milk = itemFor(items, 'milk');
  assert(milk);
  assert.equal(formatRational(milk.quantity), '3');
  assert.equal(milk.unit, 'cup');
}

{
  const items = aggregateRecipes([
    recipe('a', 'A', ['1 cup flour']),
    recipe('b', 'B', ['4 oz flour']),
  ]);
  assert.equal(items.length, 2, 'mass and volume must remain separate');
}

{
  const repeated = recipe('repeat', 'Repeat dinner', ['2 cups milk'], 4);
  const items = aggregateRecipes([repeated], {}, [], [
    { recipeId: repeated.id, servings: 4 },
    { recipeId: repeated.id, servings: 6 },
  ]);
  const milk = itemFor(items, 'milk');
  assert(milk, 'repeated planned meals should aggregate every occurrence');
  assert.equal(formatRational(milk.quantity), '5');
  assert.equal(milk.recipeContributions.length, 2);
}

{
  assert(isValidSkylightDeviceEmail('family-kitchen@ourskylight.com'));
  assert(!isValidSkylightDeviceEmail('family-kitchen@example.com'));
  assert.equal(normalizeSkylightEmailApp(undefined), 'gmail');
  assert.equal(normalizeSkylightEmailApp('invalid'), 'gmail');
  assert.equal(normalizeSkylightEmailApp('device-default'), 'device-default');
}

{
  const plannedRecipe = recipe('skylight', 'Taco night', ['8 tortillas'], 4);
  plannedRecipe.sourceURL = 'https://example.com/tacos';
  const draft = formatSkylightWeek([{
    id: 'meal_skylight', date: '2026-08-25', mealType: 'dinner', recipeId: plannedRecipe.id,
    servings: 6, revision: 1, dateModified: '2026-08-23T12:00:00.000Z',
  }], [plannedRecipe], '2026-08-23', '2026-08-29');
  assert.equal(draft.mealCount, 1);
  assert.match(draft.body, /Tuesday, August 25, 2026/);
  assert.match(draft.body, /Dinner: Taco night/);
  assert.match(draft.body, /Servings: 6/);
  assert.match(draft.body, /Recipe URL: https:\/\/example\.com\/tacos/);
  const deviceDefault = skylightMailto('FAMILY@ourskylight.com', draft);
  assert.match(deviceDefault, /^mailto:family@ourskylight\.com\?/);
  assert.match(deviceDefault, /%0D%0A/);
  assert.equal(skylightEmailDraftUrl('FAMILY@ourskylight.com', draft, 'device-default'), deviceDefault);

  const gmail = new URL(skylightGmailComposeUrl('FAMILY@ourskylight.com', draft));
  assert.equal(gmail.protocol, 'googlegmail:');
  assert.equal(gmail.pathname, '/co');
  assert.equal(gmail.searchParams.get('to'), 'family@ourskylight.com');
  assert.equal(gmail.searchParams.get('body'), draft.body.replace(/\r?\n/g, '\r\n'));
  assert.equal(gmail.searchParams.has('subject'), false);
  assert.equal(skylightEmailDraftUrl('FAMILY@ourskylight.com', draft), gmail.href);
}

{
  const specialDraft = { body: 'Dinner: Jalapeño & lime\nEmoji: 🍋? #fresh', mealCount: 1 };
  const gmail = new URL(skylightGmailComposeUrl('FAMILY+MENU@ourskylight.com', specialDraft));
  assert.equal(gmail.searchParams.get('to'), 'family+menu@ourskylight.com');
  assert.equal(gmail.searchParams.get('body'), 'Dinner: Jalapeño & lime\r\nEmoji: 🍋? #fresh');
}

{
  const plannedRecipe = recipe('all-day', 'All-day recipe', ['1 cup oats'], 4);
  const entries = ['dinner', 'snack', 'lunch', 'breakfast'].map((mealType, index) => ({
    id: `meal_all_day_${index}`,
    date: '2026-08-25',
    mealType: mealType as 'breakfast' | 'lunch' | 'snack' | 'dinner',
    recipeId: plannedRecipe.id,
    servings: 4,
    revision: 1,
    dateModified: '2026-08-23T12:00:00.000Z',
  }));
  const draft = formatSkylightWeek(entries, [plannedRecipe], '2026-08-23', '2026-08-29');
  assert.equal(draft.mealCount, 4);
  assert(draft.body.indexOf('Breakfast:') < draft.body.indexOf('Lunch:'));
  assert(draft.body.indexOf('Lunch:') < draft.body.indexOf('Snack:'));
  assert(draft.body.indexOf('Snack:') < draft.body.indexOf('Dinner:'));
}

{
  const reel = parseRecipeSourceUrl('https://www.instagram.com/reel/ABC123/?igsh=example');
  assert.equal(reel?.kind, 'instagram');
  assert.equal(reel?.sourceName, 'Instagram');
  assert.equal(parseRecipeSourceUrl('https://instagram.com.example/reel/ABC123')?.kind, 'web');
  assert.equal(parseRecipeSourceUrl('javascript:alert(1)'), null);
  assert.equal(parseRecipeSourceUrl('https://user:password@example.com/recipe'), null);
}

{
  const imported = parseRecipeText(`Creamy Lemon Chicken\nA quick weeknight dinner the whole family loves.\nINGREDIENTS 👇 • 2 chicken breasts • 1 tbsp olive oil • ½ cup cream • 1 lemon, juiced\nMETHOD 👇 1️⃣ Season and brown the chicken. 2️⃣ Add the cream and lemon, then simmer for 10 minutes.\n#weeknightdinner #chickenrecipe`);
  assert.equal(imported.draft.title, 'Creamy Lemon Chicken');
  assert.match(imported.draft.description, /quick weeknight dinner/i);
  assert.equal(imported.draft.ingredients.length, 4, 'emoji and inline Instagram bullets should become ingredient lines');
  assert.equal(imported.draft.instructions.length, 2, 'keycap-numbered Instagram steps should become instructions');
  assert.equal(imported.draft.instructions.some((step) => step.text.includes('#weeknightdinner')), false, 'social hashtags should not become cooking steps');
}

{
  const seafood = recipe('fresh-seafood', 'Fresh seafood', ['1 lb salmon']);
  const greens = recipe('fresh-greens', 'Fresh greens', ['4 cups baby spinach']);
  const meat = recipe('fresh-meat', 'Fresh meat', ['1 lb chicken breasts']);
  const pantry = recipe('pantry-meal', 'Pantry meal', ['2 cups rice']);
  const recipes = [seafood, greens, meat, pantry];
  const mealPlan = [
    { id: 'slot-pantry', date: '2026-08-23', mealType: 'dinner' as const, recipeId: pantry.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
    { id: 'slot-meat', date: '2026-08-25', mealType: 'dinner' as const, recipeId: meat.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
    { id: 'slot-greens', date: '2026-08-27', mealType: 'dinner' as const, recipeId: greens.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
    { id: 'slot-seafood', date: '2026-08-29', mealType: 'dinner' as const, recipeId: seafood.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
  ];
  const groceryItems = aggregateRecipes(recipes).map((item) => ({ ...item, purchasedAt: '2026-08-22T10:00:00.000Z' }));
  const original = structuredClone({ recipes, mealPlan, groceryItems });
  const recommendation = optimizeMealWeek({
    recipes,
    mealPlan,
    groceryItems,
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  });
  assert.deepEqual(recommendation.schedule.map((meal) => meal.recipeTitle), [
    'Fresh seafood', 'Fresh greens', 'Fresh meat', 'Pantry meal',
  ]);
  assert.equal(recommendation.dataQuality.purchaseCoverage, 1);
  assert.equal(recommendation.dataQuality.confidence.level, 'high');
  assert.equal(recommendation.dataQuality.confidence.score, 90);
  assert.deepEqual({ recipes, mealPlan, groceryItems }, original, 'optimizer must not mutate its inputs');
  assert.deepEqual(recommendation, optimizeMealWeek({
    recipes,
    mealPlan,
    groceryItems,
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  }), 'optimizer must be deterministic');
}

{
  const seafood = recipe('heuristic-seafood', 'Heuristic seafood', ['1 lb shrimp']);
  const pantry = recipe('heuristic-pantry', 'Heuristic pantry', ['1 can chickpeas']);
  const groceryItems = aggregateRecipes([seafood]).map((item) => ({ ...item, purchasedAt: 'not-a-date' }));
  const recommendation = optimizeMealWeek({
    recipes: [seafood, pantry],
    mealPlan: [
      { id: 'heuristic-pantry-slot', date: '2026-08-23', mealType: 'dinner', recipeId: pantry.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
      { id: 'heuristic-seafood-slot', date: '2026-08-24', mealType: 'dinner', recipeId: seafood.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
    ],
    groceryItems,
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  });
  assert.equal(recommendation.schedule[0].recipeId, seafood.id, 'category heuristics should still put seafood first');
  assert.equal(recommendation.dataQuality.purchaseCoverage, 0);
  assert.equal(recommendation.dataQuality.confidence.level, 'low');
  assert.match(recommendation.dataQuality.reasons.join(' '), /all ordering is heuristic/i);
  assert.match(recommendation.dataQuality.reasons.join(' '), /invalid and ignored/i);
}

{
  const prepRecipe = recipe('prep-chicken-bowl', 'Prep chicken bowl', [
    '1 lb chicken breasts', '2 carrots', '1 yellow onion', '2 cups jasmine rice',
    '2 tbsp soy sauce', '1 tbsp honey',
  ]);
  prepRecipe.instructions = [
    { id: 'prep-step-1', stepNumber: 1, section: null, text: 'Season and marinate the chicken overnight.', timerMinutes: null },
    { id: 'prep-step-2', stepNumber: 2, section: null, text: 'Cook the rice until tender.', timerMinutes: null },
    { id: 'prep-step-3', stepNumber: 3, section: null, text: 'Whisk soy sauce and honey into a sauce.', timerMinutes: null },
  ];
  const groceries = aggregateRecipes([prepRecipe]).map((item) => ({ ...item, purchasedAt: '2026-08-23T08:00:00.000Z' }));
  const recommendation = optimizeMealWeek({
    recipes: [prepRecipe],
    mealPlan: [{ id: 'prep-slot', date: '2026-08-24', mealType: 'dinner', recipeId: prepRecipe.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' }],
    groceryItems: groceries,
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  });
  const kinds = new Set(recommendation.sundayPrep.tasks.map((task) => task.kind));
  assert(kinds.has('marinate'));
  assert(kinds.has('chop-sturdy-produce'));
  assert(kinds.has('make-sauce'));
  assert(kinds.has('cook-grain-or-bean'));
  assert(!recommendation.sundayPrep.warnings.some((warning) => warning.kind === 'raw-meat'));
}

{
  const lateSeafood = recipe('late-seafood', 'Late seafood supper', ['1 lb salmon', '3 cups spinach', '1 lb potatoes']);
  lateSeafood.instructions = [{
    id: 'late-seafood-step', stepNumber: 1, section: null, text: 'Season the salmon and roast with potatoes.', timerMinutes: null,
  }];
  const recommendation = optimizeMealWeek({
    recipes: [lateSeafood],
    mealPlan: [{ id: 'late-seafood-slot', date: '2026-08-27', mealType: 'dinner', recipeId: lateSeafood.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' }],
    groceryItems: [],
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  });
  const warningKinds = new Set(recommendation.sundayPrep.warnings.map((warning) => warning.kind));
  assert(warningKinds.has('seafood'));
  assert(warningKinds.has('delicate-greens'));
  assert(warningKinds.has('cut-potatoes'));
  assert(!recommendation.sundayPrep.tasks.some((task) => task.kind === 'marinate'), 'seafood must not be marinated on Sunday for Thursday');
}

{
  const seafoodLunch = recipe('seafood-lunch', 'Seafood lunch', ['1 lb salmon', '2 cups rice']);
  seafoodLunch.instructions = [{ id: 'seafood-lunch-step', stepNumber: 1, section: null, text: 'Cook rice and roast salmon.', timerMinutes: null }];
  const pantryLunch = recipe('pantry-lunch', 'Pantry lunch', ['1 can chickpeas', '1 cup quinoa']);
  pantryLunch.instructions = [{ id: 'pantry-lunch-step', stepNumber: 1, section: null, text: 'Cook quinoa and combine with chickpeas.', timerMinutes: null }];
  const recommendation = optimizeMealWeek({
    recipes: [seafoodLunch, pantryLunch],
    mealPlan: [
      { id: 'pantry-lunch-slot', date: '2026-08-24', mealType: 'lunch', recipeId: pantryLunch.id, servings: 2, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
      { id: 'seafood-lunch-slot', date: '2026-08-28', mealType: 'lunch', recipeId: seafoodLunch.id, servings: 2, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
      { id: 'missing-lunch-slot', date: '2026-08-26', mealType: 'lunch', recipeId: 'missing-recipe', servings: 2, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
    ],
    groceryItems: [],
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  });
  assert.equal(recommendation.schedule[0].recipeId, seafoodLunch.id, 'more perishable Sunday-prepped lunches should be eaten first');
  assert(recommendation.schedule.every((meal) => meal.ingredientUseDate === '2026-08-23'));
  assert(recommendation.sundayPrep.tasks.some((task) => task.kind === 'portion-lunch'));
  assert(recommendation.sundayPrep.warnings.some((warning) => warning.kind === 'refrigerated-lunch'));
  assert.deepEqual(recommendation.unresolvedEntries, [{
    sourceEntryId: 'missing-lunch-slot', recipeId: 'missing-recipe', originalDate: '2026-08-26', reason: 'missing-recipe',
  }]);
}

{
  assert.throws(() => optimizeMealWeek({
    recipes: [], mealPlan: [], groceryItems: [], week: { startDate: '2026-08-29', endDate: '2026-08-23' },
  }), /must not be before/);
}

{
  const seafood = recipe('same-day-seafood', 'Same-day seafood', ['1 lb salmon']);
  const pantry = recipe('same-day-pantry', 'Same-day pantry', ['1 can chickpeas']);
  const recommendation = optimizeMealWeek({
    recipes: [seafood, pantry],
    mealPlan: [
      { id: 'same-day-a', date: '2026-08-25', mealType: 'dinner', recipeId: pantry.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
      { id: 'same-day-b', date: '2026-08-25', mealType: 'dinner', recipeId: seafood.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
    ],
    groceryItems: [],
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  });
  assert(recommendation.schedule.every((meal) => !meal.moved));
  assert(recommendation.schedule.every((meal) => !meal.reasons.some((reason) => reason.startsWith('Moved from'))));
}

{
  const seafood = recipe('saved-prep-seafood', 'Saved-plan seafood', ['1 lb salmon']);
  const pantry = recipe('saved-prep-pantry', 'Saved-plan pantry', ['1 can chickpeas']);
  const input = {
    recipes: [seafood, pantry],
    mealPlan: [
      { id: 'saved-pantry-slot', date: '2026-08-23', mealType: 'dinner' as const, recipeId: pantry.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
      { id: 'saved-seafood-slot', date: '2026-08-27', mealType: 'dinner' as const, recipeId: seafood.id, servings: 4, revision: 1, dateModified: '2026-08-20T12:00:00.000Z' },
    ],
    groceryItems: [],
    week: { startDate: '2026-08-23', endDate: '2026-08-29' },
  };
  const optimized = optimizeMealWeek(input);
  const prepReference = buildSundayPrepRecommendation(input);
  assert.equal(optimized.schedule[0].recipeId, seafood.id, 'optimizer may propose moving seafood earlier');
  assert.deepEqual(prepReference.schedule.map((meal) => [meal.recipeId, meal.date]), [
    [pantry.id, '2026-08-23'], [seafood.id, '2026-08-27'],
  ], 'prep reference must use the saved dates until optimization is applied');
  assert(prepReference.schedule.every((meal) => !meal.moved));
  const seafoodWarning = prepReference.sundayPrep.warnings.find((warning) => warning.kind === 'seafood');
  assert.match(seafoodWarning?.recommendation ?? '', /keep it frozen/i);
}

{
  // A recipe imported from Instagram carries no hero image. An earlier build
  // stored that as "" instead of null, and every later sync then rejected the
  // whole household file with "contains invalid records".
  assert.equal(isImageReference(null), true);
  assert.equal(isImageReference(''), true, 'a blank hero image must not invalidate the household file');
  assert.equal(normalizeImageReference(''), null, 'a blank hero image must be stored as null');
  assert.equal(normalizeImageReference(null), null);
  assert.equal(normalizeImageReference('./recipes/lemon-chicken.jpg'), './recipes/lemon-chicken.jpg');
  assert.equal(isImageReference('./recipes/lemon-chicken.jpg'), true);
  assert.equal(isImageReference(`github-media:savor/v1/media/${'a'.repeat(64)}.webp`), true);
  assert.equal(isImageReference('data:image/webp;base64,UklGRg=='), true);
  assert.equal(isImageReference('https://images.example.com/dish.jpg'), true);
  assert.equal(isImageReference('javascript:alert(1)'), false, 'unsafe references must still be rejected');
  assert.equal(isImageReference('data:text/html;base64,PHNjcmlwdD4='), false);
  assert.equal(isImageReference(42), false);
}

type Parsed = ReturnType<typeof parseIngredientLine>;
type Expected = Partial<{
  quantity: string; quantityMax: string | null; unit: string | null; ingredientName: string; normalizedIngredient: string;
  groceryCategory: Parsed['groceryCategory']; needsReview: boolean; approximate: boolean; toTaste: boolean;
  skipGrocery: boolean; optional: boolean; note: string | null; preparation: string | null; descriptor: string | null;
}>;

function expectLine(line: string, expected: Expected, section: string | null = null): Parsed {
  const parsed = parseIngredientLine(line, section);
  const actual: Record<string, unknown> = {
    ...parsed,
    quantity: formatRational(parsed.quantity),
    quantityMax: parsed.quantityMax ? formatRational(parsed.quantityMax) : null,
    approximate: Boolean(parsed.approximate), toTaste: Boolean(parsed.toTaste), skipGrocery: Boolean(parsed.skipGrocery),
    note: parsed.note ?? null,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `"${line}" → ${key} should be ${JSON.stringify(value)} but was ${JSON.stringify(actual[key])}`);
  }
  return parsed;
}

{
  // 1a/1b: bullets are stripped (never a leading number); word quantities and amount words.
  expectLine('- 2 cups flour', { quantity: '2', unit: 'cup', ingredientName: 'flour', groceryCategory: 'Pantry', needsReview: false });
  expectLine('• 1 tsp salt', { quantity: '1', unit: 'tsp', ingredientName: 'salt' });
  expectLine('* 3 eggs', { quantity: '3', unit: 'each', ingredientName: 'eggs', normalizedIngredient: 'egg', groceryCategory: 'Dairy & Eggs' });
  assert.equal(parseIngredientLine('– 12 oz rigatoni').rawText, '12 oz rigatoni', 'the bullet is removed from rawText but the number stays');
  expectLine('a splash of water', { quantity: '1', unit: 'splash', ingredientName: 'water', skipGrocery: true, approximate: true, needsReview: false });
  expectLine('pinch of salt', { quantity: '1', unit: 'pinch', ingredientName: 'salt', normalizedIngredient: 'salt', groceryCategory: 'Spices & Seasonings', approximate: true });
  expectLine('a handful of parsley', { quantity: '1', unit: 'handful', ingredientName: 'parsley', groceryCategory: 'Produce', approximate: true });
  expectLine('a couple of eggs', { quantity: '2', unit: 'each', ingredientName: 'eggs', approximate: true });
  expectLine('a few sprigs thyme', { quantity: '3', unit: 'sprig', ingredientName: 'thyme', groceryCategory: 'Produce', approximate: true });
  expectLine('an onion', { quantity: '1', unit: 'each', ingredientName: 'onion', approximate: false, needsReview: false });
  expectLine('half a lemon', { quantity: '½', unit: 'each', ingredientName: 'lemon' });
  expectLine('two carrots', { quantity: '2', unit: 'each', normalizedIngredient: 'carrot' });
  expectLine('a dash of hot sauce', { quantity: '1', unit: 'dash', ingredientName: 'hot sauce', groceryCategory: 'Sauces & Condiments' });
  expectLine('1 cup half-and-half', { quantity: '1', unit: 'cup', ingredientName: 'half-and-half', groceryCategory: 'Dairy & Eggs' });
}

{
  // 1c: metric amounts with no space, container sizes and "x" multipliers.
  expectLine('600g boneless, skinless chicken thighs, diced', {
    quantity: '600', unit: 'g', ingredientName: 'boneless skinless chicken thighs', preparation: 'diced',
    groceryCategory: 'Meat & Seafood', needsReview: false,
  });
  expectLine('250ml milk', { quantity: '250', unit: 'ml', ingredientName: 'milk', groceryCategory: 'Dairy & Eggs' });
  expectLine('1.5kg potatoes', { quantity: '1½', unit: 'kg', normalizedIngredient: 'potato', groceryCategory: 'Produce' });
  expectLine('400g tin tomatoes', { quantity: '400', unit: 'g', ingredientName: 'tomatoes', note: 'tin', groceryCategory: 'Canned & Jarred' });
  const canned = expectLine('1 x 400g can chopped tomatoes', { quantity: '1', unit: 'can', ingredientName: 'chopped tomatoes', groceryCategory: 'Canned & Jarred', needsReview: false });
  assert.match(canned.note ?? '', /400g/);
  expectLine('2 x 400g tins chickpeas', { quantity: '2', unit: 'can', ingredientName: 'chickpeas', groceryCategory: 'Canned & Jarred' });
  expectLine('1 ½ cups rice', { quantity: '1½', unit: 'cup', ingredientName: 'rice' });
  expectLine('1½ lb salmon', { quantity: '1½', unit: 'lb', ingredientName: 'salmon', groceryCategory: 'Meat & Seafood' });
}

{
  // 1d: unit aliases map to stable codes; the old t/T/c "ambiguous" review flag is gone.
  const cases: Array<[string, string, string]> = [
    ['2 T butter', '2', 'tbsp'], ['1 t vanilla', '1', 'tsp'], ['1 c sugar', '1', 'cup'], ['2 C flour', '2', 'cup'],
    ['2 tbs soy sauce', '2', 'tbsp'], ['3 Tbsp honey', '3', 'tbsp'], ['1 TBSP oil', '1', 'tbsp'], ['2 tsps cumin', '2', 'tsp'],
    ['1 tin coconut milk', '1', 'can'], ['100 gr flour', '100', 'g'], ['200 grams sugar', '200', 'g'], ['1 L water', '1', 'l'],
    ['50 cl cream', '50', 'cl'], ['2 heads garlic', '2', 'head'], ['1 stick butter', '1', 'stick'], ['2 stalks celery', '2', 'stalk'],
    ['3 sprigs rosemary', '3', 'sprig'], ['4 leaves basil', '4', 'leaf'], ['2 pieces ginger', '2', 'piece'], ['2 fillets cod', '2', 'fillet'],
    ['3 ears corn', '3', 'ear'], ['2 ribs celery', '2', 'rib'], ['4 wedges lime', '4', 'wedge'], ['2 sheets puff pastry', '2', 'sheet'],
    ['1 bottle hot sauce', '1', 'bottle'], ['1 bag spinach', '1', 'bag'], ['1 box pasta', '1', 'box'], ['1 container yogurt', '1', 'container'],
    ['1 carton chicken broth', '1', 'carton'], ['1 packet taco seasoning', '1', 'package'], ['1 envelope yeast', '1', 'package'],
    ['1 quart stock', '1', 'quart'], ['1 qt milk', '1', 'quart'], ['1 pint cherry tomatoes', '1', 'pint'], ['1 pt cream', '1', 'pint'],
    ['1 gallon water', '1', 'gallon'], ['2 cups rice', '2', 'cup'], ['8 oz cheddar', '8', 'oz'], ['2 lb potatoes', '2', 'lb'],
  ];
  for (const [line, quantity, unit] of cases) expectLine(line, { quantity, unit, needsReview: false });
  expectLine('1 tomato', { unit: 'each', ingredientName: 'tomato' }, null);
  expectLine('2 tacos', { unit: 'each', ingredientName: 'tacos' });
  assert.equal(pluralizeUnit('tbsp', 3), 'tbsp');
  assert.equal(pluralizeUnit('g', 500), 'g');
  assert.equal(pluralizeUnit('clove', 2), 'cloves');
  assert.equal(pluralizeUnit('cup', rational(1, 2)), 'cup');
  assert.equal(pluralizeUnit('can', 2), 'cans');
  assert.equal(pluralizeUnit('head', 3), 'heads');
  assert.equal(pluralizeUnit('each', 3), '');
}

{
  // 1e + 1m: "of" after a unit, and garlic always normalizes to cloves of garlic.
  expectLine('2 cloves of garlic', { quantity: '2', unit: 'clove', ingredientName: 'garlic', normalizedIngredient: 'garlic', groceryCategory: 'Produce' });
  expectLine('1 cup of flour', { quantity: '1', unit: 'cup', ingredientName: 'flour' });
  expectLine('2 cans of black beans', { quantity: '2', unit: 'can', ingredientName: 'black beans', groceryCategory: 'Canned & Jarred' });
  expectLine('3 garlic cloves, minced', { quantity: '3', unit: 'clove', ingredientName: 'garlic', normalizedIngredient: 'garlic', preparation: 'minced' });
  expectLine('1 garlic clove', { quantity: '1', unit: 'clove', normalizedIngredient: 'garlic' });
  expectLine('4 cloves garlic', { quantity: '4', unit: 'clove', normalizedIngredient: 'garlic' });
}

{
  // 1f: ranges keep the lower bound as quantity and the upper bound as quantityMax, without a review flag.
  expectLine('2-3 cloves garlic', { quantity: '2', quantityMax: '3', unit: 'clove', ingredientName: 'garlic', approximate: true, needsReview: false });
  expectLine('1–2 teaspoon Dijon mustard', { quantity: '1', quantityMax: '2', unit: 'tsp', ingredientName: 'Dijon mustard', groceryCategory: 'Sauces & Condiments', approximate: true, needsReview: false });
  expectLine('2 to 3 tbsp olive oil', { quantity: '2', quantityMax: '3', unit: 'tbsp', ingredientName: 'olive oil', approximate: true, needsReview: false });
  expectLine('1/2-1 tsp cayenne', { quantity: '½', quantityMax: '1', unit: 'tsp', ingredientName: 'cayenne', groceryCategory: 'Spices & Seasonings', needsReview: false });
  expectLine('1 or 2 jalapeños', { quantity: '1', quantityMax: '2', unit: 'each', groceryCategory: 'Produce' });
}

{
  // 1g: parentheticals become notes or the optional flag and never reach the name.
  expectLine('1 (14 oz) can chickpeas', { quantity: '1', unit: 'can', ingredientName: 'chickpeas', normalizedIngredient: 'chickpeas', note: '14 oz', groceryCategory: 'Canned & Jarred' });
  expectLine('2 cups flour (250g)', { quantity: '2', unit: 'cup', ingredientName: 'flour', normalizedIngredient: 'flour', note: '250g' });
  expectLine('1 cup cheddar (optional)', { quantity: '1', unit: 'cup', ingredientName: 'cheddar', optional: true, note: null });
  expectLine('1 tbsp capers (see note)', { ingredientName: 'capers', normalizedIngredient: 'caper', note: 'see note' });
  expectLine('1 cup walnuts, optional', { ingredientName: 'walnuts', optional: true });
  expectLine('1 (2-inch) piece ginger', { quantity: '1', unit: 'piece', ingredientName: 'ginger', note: '2-inch' });
  expectLine('1 2-inch piece ginger', { quantity: '1', unit: 'piece', ingredientName: 'ginger', note: '2-inch' });
}

{
  // 1h: citrus phrasing.
  expectLine('½ a lemon', { quantity: '½', unit: 'each', ingredientName: 'lemon', normalizedIngredient: 'lemon' });
  expectLine('juice of 1 lemon', { quantity: '1', unit: 'each', ingredientName: 'lemon', note: 'juice of', groceryCategory: 'Produce' });
  expectLine('zest and juice of 2 limes', { quantity: '2', unit: 'each', ingredientName: 'limes', normalizedIngredient: 'lime', note: 'zest and juice of' });
  expectLine('1 lemon, juiced', { quantity: '1', unit: 'each', ingredientName: 'lemon', preparation: 'juiced' });
  expectLine('Juice of ½ lemon', { quantity: '½', unit: 'each', ingredientName: 'lemon' });
}

{
  // 1i: the cook decides the amount.
  expectLine('salt and pepper to taste', { quantity: '', unit: null, ingredientName: 'salt and pepper', normalizedIngredient: 'salt and pepper', toTaste: true, groceryCategory: 'Spices & Seasonings', needsReview: false });
  expectLine('olive oil, for frying', { quantity: '', ingredientName: 'olive oil', toTaste: true, needsReview: false });
  expectLine('Kosher salt', { quantity: '', unit: null, ingredientName: 'Kosher salt', normalizedIngredient: 'kosher salt', toTaste: true, needsReview: false });
  expectLine('Pepper', { quantity: '', ingredientName: 'Pepper', normalizedIngredient: 'pepper', toTaste: true, needsReview: false, groceryCategory: 'Spices & Seasonings' });
  expectLine('Freshly ground black pepper', { quantity: '', ingredientName: 'Freshly ground black pepper', toTaste: true, needsReview: false, groceryCategory: 'Spices & Seasonings' });
  expectLine('Lime wedges, for serving', { ingredientName: 'Lime wedges', toTaste: true, needsReview: false, groceryCategory: 'Produce' });
  expectLine('2 tbsp butter, plus more for greasing', { quantity: '2', unit: 'tbsp', ingredientName: 'butter', toTaste: true });
  expectLine('Chopped parsley, for garnish', { ingredientName: 'parsley', toTaste: true, needsReview: false });
  expectLine('1 tsp salt, or more to taste', { quantity: '1', ingredientName: 'salt', toTaste: true });
  expectLine('Flaky salt, to finish', { ingredientName: 'Flaky salt', toTaste: true });
  expectLine('Vegetable oil, as needed', { ingredientName: 'Vegetable oil', toTaste: true, needsReview: false });
  assert.equal(parseIngredientLine('salt and pepper to taste').rawText, 'salt and pepper to taste', 'the phrase stays in rawText');
}

{
  // 1j: alternatives are kept as notes; an unquantified primary needs a look.
  expectLine('Spray oil or 1 tbsp olive oil', { quantity: '', ingredientName: 'Spray oil', note: 'or 1 tbsp olive oil', needsReview: true, groceryCategory: 'Sauces & Condiments' });
  expectLine('1 cup milk or cream', { quantity: '1', unit: 'cup', ingredientName: 'milk', normalizedIngredient: 'milk', note: 'or cream', needsReview: false });
  expectLine('1 lemon or lime', { ingredientName: 'lemon', note: 'or lime' });
}

{
  // 1k: water and ice never reach the list; flavored waters do.
  for (const line of ['water', '1 cup water', 'ice', 'ice cubes', 'crushed ice', '2 cups warm water', 'hot water', 'boiling water', 'cold water', 'lukewarm water', 'tap water', 'filtered water', 'iced water', 'room-temperature water', 'a splash of water to loosen', 'Splash of water to loosen']) {
    expectLine(line, { skipGrocery: true, needsReview: false });
  }
  for (const line of ['1 cup coconut water', 'rose water', '1 tsp orange blossom water', '1 cup sparkling water', 'soda water', 'tonic water', 'mineral water']) {
    expectLine(line, { skipGrocery: false });
  }
}

{
  // 1l: preparation words are split off; product names keep their first word.
  expectLine('finely chopped parsley', { ingredientName: 'parsley', normalizedIngredient: 'parsley', preparation: 'finely chopped', groceryCategory: 'Produce' });
  expectLine('chopped fresh cilantro', { ingredientName: 'fresh cilantro', preparation: 'chopped' });
  expectLine('1 cup cooked rice', { ingredientName: 'rice', preparation: 'cooked' });
  expectLine('2 eggs, lightly beaten', { ingredientName: 'eggs', preparation: 'lightly beaten' });
  expectLine('1 onion, finely diced', { ingredientName: 'onion', preparation: 'finely diced' });
  expectLine('2 carrots diced', { ingredientName: 'carrots', preparation: 'diced' });
  expectLine('1 cup walnuts, toasted and chopped', { ingredientName: 'walnuts', preparation: 'toasted and chopped' });
  expectLine('4 tbsp butter, at room temperature', { ingredientName: 'butter', preparation: 'at room temperature' });
  expectLine('1 cucumber, cut into half moons', { ingredientName: 'cucumber', preparation: 'cut into half moons' });
  expectLine('1 lb shrimp, peeled and deveined', { ingredientName: 'shrimp', preparation: 'peeled and deveined' });
  for (const [line, name] of [
    ['1 lb ground beef', 'ground beef'], ['1 tsp ground cumin', 'ground cumin'], ['1 can crushed tomatoes', 'crushed tomatoes'],
    ['1 tsp crushed red pepper', 'crushed red pepper'], ['1 whole chicken', 'whole chicken'], ['1 tsp dried oregano', 'dried oregano'],
    ['1 tsp smoked paprika', 'smoked paprika'], ['1 cup roasted red peppers', 'roasted red peppers'], ['1 can canned pumpkin', 'canned pumpkin'],
    ['1 bag frozen peas', 'frozen peas'], ['2 cups fresh spinach', 'fresh spinach'],
  ] as const) expectLine(line, { ingredientName: name, preparation: null });
}

{
  // 1m: normalization — singularization with exceptions, and synonyms.
  const cases: Array<[string, string]> = [
    ['tomatoes', 'tomato'], ['potatoes', 'potato'], ['cherries', 'cherry'], ['radishes', 'radish'], ['boxes', 'box'], ['eggs', 'egg'],
    ['limes', 'lime'], ['leaves', 'leaf'], ['bay leaves', 'bay leaf'], ['chicken thighs', 'chicken thigh'], ['olives', 'olive'],
    ['hummus', 'hummus'], ['couscous', 'couscous'], ['molasses', 'molasses'], ['asparagus', 'asparagus'], ['swiss', 'swiss'],
    ['chips', 'chips'], ['oats', 'oats'], ['grits', 'grits'], ['greens', 'greens'], ['lentils', 'lentils'], ['peas', 'peas'],
    ['beans', 'beans'], ['green beans', 'green beans'], ['noodles', 'noodles'], ['sprouts', 'sprouts'], ['seeds', 'seeds'],
    ['nuts', 'nuts'], ['flakes', 'flakes'], ['red pepper flakes', 'red pepper flakes'], ['chickpeas', 'chickpeas'],
    ['scallions', 'green onion'], ['Spring onions', 'green onion'], ['scallion', 'green onion'], ['coriander leaves', 'cilantro'],
    ['fresh coriander', 'cilantro'], ['confectioners sugar', 'powdered sugar'], ["confectioners' sugar", 'powdered sugar'],
    ['icing sugar', 'powdered sugar'], ['garbanzo beans', 'chickpeas'], ['aubergine', 'eggplant'], ['courgettes', 'zucchini'],
    ['capsicum', 'bell pepper'], ['yoghurt', 'yogurt'], ['Greek yoghurt', 'greek yogurt'], ['mayo', 'mayonnaise'],
    ['EVOO', 'extra virgin olive oil'], ['extra-virgin olive oil', 'extra virgin olive oil'], ['garlic cloves', 'garlic'],
    ['cloves garlic', 'garlic'], ['garlic clove', 'garlic'], ['salt & pepper', 'salt and pepper'], ['peppers', 'bell pepper'],
    ['chillies', 'chili'], ['Cheddar (sharp)', 'cheddar'], ['  Baby   Spinach ', 'baby spinach'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeIngredientName(input), expected, `normalize "${input}"`);
}

{
  // 1n: the aisle table, with the ordering traps called out in the task.
  const expectations: Array<[string, Parsed['groceryCategory']]> = [
    ['corn tortillas', 'Bakery'], ['flour tortillas', 'Bakery'], ['pita', 'Bakery'], ['naan', 'Bakery'], ['bagel', 'Bakery'], ['baguette', 'Bakery'],
    ['bread', 'Bakery'], ['buns', 'Bakery'], ['rolls', 'Bakery'], ['croissant', 'Bakery'],
    ['breadcrumbs', 'Pantry'], ['panko', 'Pantry'],
    ['cream cheese', 'Dairy & Eggs'], ['cheddar', 'Dairy & Eggs'], ['mozzarella', 'Dairy & Eggs'], ['parmesan', 'Dairy & Eggs'], ['feta', 'Dairy & Eggs'],
    ['goat cheese', 'Dairy & Eggs'], ['ricotta', 'Dairy & Eggs'], ['yogurt', 'Dairy & Eggs'], ['greek yogurt', 'Dairy & Eggs'], ['sour cream', 'Dairy & Eggs'],
    ['heavy cream', 'Dairy & Eggs'], ['half and half', 'Dairy & Eggs'], ['butter', 'Dairy & Eggs'], ['ghee', 'Dairy & Eggs'], ['buttermilk', 'Dairy & Eggs'],
    ['eggs', 'Dairy & Eggs'], ['egg', 'Dairy & Eggs'], ['almond milk', 'Dairy & Eggs'], ['oat milk', 'Dairy & Eggs'], ['pepper jack cheese', 'Dairy & Eggs'],
    ['coconut milk', 'Canned & Jarred'], ['chicken broth', 'Canned & Jarred'], ['beef stock', 'Canned & Jarred'], ['vegetable broth', 'Canned & Jarred'],
    ['bone broth', 'Canned & Jarred'], ['canned corn', 'Canned & Jarred'], ['tin of tomatoes', 'Canned & Jarred'], ['can of coconut cream', 'Canned & Jarred'],
    ['chickpeas', 'Canned & Jarred'], ['black beans', 'Canned & Jarred'], ['kidney beans', 'Canned & Jarred'], ['cannellini beans', 'Canned & Jarred'],
    ['dried cannellini beans', 'Pasta, Rice & Grains'], ['crushed tomatoes', 'Canned & Jarred'], ['diced tomatoes', 'Canned & Jarred'],
    ['whole peeled tomatoes', 'Canned & Jarred'], ['tomato paste', 'Canned & Jarred'], ['tomato sauce', 'Canned & Jarred'], ['passata', 'Canned & Jarred'],
    ['pumpkin puree', 'Canned & Jarred'], ['olives', 'Canned & Jarred'], ['capers', 'Canned & Jarred'], ['pickles', 'Canned & Jarred'],
    ['roasted red peppers', 'Canned & Jarred'], ['artichoke hearts', 'Canned & Jarred'], ['sun-dried tomatoes', 'Canned & Jarred'],
    ['jarred salsa', 'Canned & Jarred'], ['marinara', 'Canned & Jarred'], ['pesto', 'Canned & Jarred'], ['tuna', 'Canned & Jarred'],
    ['canned tuna', 'Canned & Jarred'], ['tuna steak', 'Meat & Seafood'], ['cream of mushroom soup', 'Canned & Jarred'],
    ['dried beans', 'Pasta, Rice & Grains'], ['lentils', 'Pasta, Rice & Grains'], ['rice', 'Pasta, Rice & Grains'], ['quinoa', 'Pasta, Rice & Grains'],
    ['spaghetti', 'Pasta, Rice & Grains'], ['penne', 'Pasta, Rice & Grains'], ['rigatoni', 'Pasta, Rice & Grains'], ['orzo', 'Pasta, Rice & Grains'],
    ['macaroni', 'Pasta, Rice & Grains'], ['lasagna noodles', 'Pasta, Rice & Grains'], ['egg noodles', 'Pasta, Rice & Grains'], ['rice noodles', 'Pasta, Rice & Grains'],
    ['ramen', 'Pasta, Rice & Grains'], ['couscous', 'Pasta, Rice & Grains'], ['farro', 'Pasta, Rice & Grains'], ['barley', 'Pasta, Rice & Grains'],
    ['bulgur', 'Pasta, Rice & Grains'], ['polenta', 'Pasta, Rice & Grains'], ['oats', 'Pasta, Rice & Grains'],
    ['peanut butter', 'Pantry'], ['tahini', 'Pantry'], ['honey', 'Pantry'], ['maple syrup', 'Pantry'], ['sugar', 'Pantry'], ['brown sugar', 'Pantry'],
    ['flour', 'Pantry'], ['baking powder', 'Pantry'], ['baking soda', 'Pantry'], ['yeast', 'Pantry'], ['cornstarch', 'Pantry'], ['cocoa', 'Pantry'],
    ['chocolate chips', 'Pantry'], ['vanilla extract', 'Pantry'], ['almonds', 'Pantry'], ['walnuts', 'Pantry'], ['pecans', 'Pantry'], ['cashews', 'Pantry'],
    ['peanuts', 'Pantry'], ['chia seeds', 'Pantry'], ['flax seeds', 'Pantry'], ['sesame seeds', 'Pantry'], ['pumpkin seeds', 'Pantry'], ['sunflower seeds', 'Pantry'],
    ['dried cranberries', 'Pantry'], ['raisins', 'Pantry'], ['crackers', 'Pantry'], ['tortilla chips', 'Pantry'],
    ['frozen peas', 'Frozen'], ['frozen corn', 'Frozen'], ['frozen spinach', 'Frozen'], ['ice cream', 'Frozen'], ['puff pastry', 'Frozen'], ['phyllo', 'Frozen'],
    ['salt', 'Spices & Seasonings'], ['kosher salt', 'Spices & Seasonings'], ['sea salt', 'Spices & Seasonings'], ['black pepper', 'Spices & Seasonings'],
    ['white pepper', 'Spices & Seasonings'], ['cayenne pepper', 'Spices & Seasonings'], ['red pepper flakes', 'Spices & Seasonings'],
    ['chili powder', 'Spices & Seasonings'], ['paprika', 'Spices & Seasonings'], ['cumin', 'Spices & Seasonings'], ['ground coriander', 'Spices & Seasonings'],
    ['coriander', 'Spices & Seasonings'], ['turmeric', 'Spices & Seasonings'], ['garlic powder', 'Spices & Seasonings'], ['onion powder', 'Spices & Seasonings'],
    ['oregano', 'Spices & Seasonings'], ['dried oregano', 'Spices & Seasonings'], ['dried thyme', 'Spices & Seasonings'], ['bay leaves', 'Spices & Seasonings'],
    ['cinnamon', 'Spices & Seasonings'], ['nutmeg', 'Spices & Seasonings'], ['curry powder', 'Spices & Seasonings'], ['garam masala', 'Spices & Seasonings'],
    ['italian seasoning', 'Spices & Seasonings'], ['taco seasoning', 'Spices & Seasonings'], ['bouillon', 'Spices & Seasonings'], ['pepper', 'Spices & Seasonings'],
    ['salt and pepper', 'Spices & Seasonings'], ['freshly ground black pepper', 'Spices & Seasonings'],
    ['olive oil', 'Sauces & Condiments'], ['vegetable oil', 'Sauces & Condiments'], ['canola oil', 'Sauces & Condiments'], ['sesame oil', 'Sauces & Condiments'],
    ['coconut oil', 'Sauces & Condiments'], ['cooking spray', 'Sauces & Condiments'], ['vinegar', 'Sauces & Condiments'], ['apple cider vinegar', 'Sauces & Condiments'],
    ['rice vinegar', 'Sauces & Condiments'], ['soy sauce', 'Sauces & Condiments'], ['tamari', 'Sauces & Condiments'], ['fish sauce', 'Sauces & Condiments'],
    ['oyster sauce', 'Sauces & Condiments'], ['hoisin', 'Sauces & Condiments'], ['worcestershire', 'Sauces & Condiments'], ['hot sauce', 'Sauces & Condiments'],
    ['sriracha', 'Sauces & Condiments'], ['ketchup', 'Sauces & Condiments'], ['dijon mustard', 'Sauces & Condiments'], ['yellow mustard', 'Sauces & Condiments'],
    ['whole grain mustard', 'Sauces & Condiments'], ['mayonnaise', 'Sauces & Condiments'], ['bbq sauce', 'Sauces & Condiments'], ['salad dressing', 'Sauces & Condiments'],
    ['mirin', 'Sauces & Condiments'], ['cooking wine', 'Sauces & Condiments'],
    ['bell pepper', 'Produce'], ['red pepper', 'Produce'], ['jalapeño', 'Produce'], ['poblano', 'Produce'], ['onion', 'Produce'], ['red onion', 'Produce'],
    ['shallot', 'Produce'], ['garlic', 'Produce'], ['ginger', 'Produce'], ['lemon', 'Produce'], ['lime', 'Produce'], ['orange', 'Produce'], ['apple', 'Produce'],
    ['banana', 'Produce'], ['berries', 'Produce'], ['strawberries', 'Produce'], ['avocado', 'Produce'], ['tomato', 'Produce'], ['cherry tomatoes', 'Produce'],
    ['cucumber', 'Produce'], ['lettuce', 'Produce'], ['romaine', 'Produce'], ['butter lettuce', 'Produce'], ['spinach', 'Produce'], ['kale', 'Produce'],
    ['arugula', 'Produce'], ['cabbage', 'Produce'], ['carrot', 'Produce'], ['celery', 'Produce'], ['potato', 'Produce'], ['sweet potato', 'Produce'],
    ['zucchini', 'Produce'], ['squash', 'Produce'], ['mushroom', 'Produce'], ['broccoli', 'Produce'], ['cauliflower', 'Produce'], ['asparagus', 'Produce'],
    ['green beans', 'Produce'], ['peas', 'Produce'], ['corn', 'Produce'], ['basil', 'Produce'], ['parsley', 'Produce'], ['cilantro', 'Produce'],
    ['dill', 'Produce'], ['mint', 'Produce'], ['rosemary', 'Produce'], ['thyme', 'Produce'], ['fresh thyme', 'Produce'], ['chives', 'Produce'],
    ['fresh oregano', 'Produce'], ['scallions', 'Produce'], ['green onion', 'Produce'], ['lemon juice', 'Produce'], ['lime juice', 'Produce'], ['tofu', 'Produce'],
    ['peppers', 'Produce'], ['swiss chard', 'Produce'], ['celery ribs', 'Produce'], ['fresh herbs', 'Produce'],
    ['chicken', 'Meat & Seafood'], ['chicken thighs', 'Meat & Seafood'], ['boneless skinless chicken breasts', 'Meat & Seafood'], ['beef', 'Meat & Seafood'],
    ['steak', 'Meat & Seafood'], ['ground beef', 'Meat & Seafood'], ['pork', 'Meat & Seafood'], ['bacon', 'Meat & Seafood'], ['ham', 'Meat & Seafood'],
    ['prosciutto', 'Meat & Seafood'], ['sausage', 'Meat & Seafood'], ['lamb', 'Meat & Seafood'], ['turkey', 'Meat & Seafood'], ['salmon', 'Meat & Seafood'],
    ['cod', 'Meat & Seafood'], ['shrimp', 'Meat & Seafood'], ['prawns', 'Meat & Seafood'], ['scallops', 'Meat & Seafood'], ['crab', 'Meat & Seafood'],
    ['fish', 'Meat & Seafood'],
  ];
  const mismatches = expectations
    .filter(([name, expected]) => groceryCategoryFor(normalizeIngredientName(name)) !== expected)
    .map(([name, expected]) => `${name}: ${groceryCategoryFor(normalizeIngredientName(name))} (expected ${expected})`);
  assert.deepEqual(mismatches, [], 'every aisle expectation must hold');
  assert.equal(groceryCategoryFor('unobtainium'), 'Other');
}

{
  // 2: pantry staples.
  const staples = DEFAULT_STAPLES;
  assert.equal(matchesPantryStaple('salt', staples), true);
  assert.equal(matchesPantryStaple('fine sea salt', ['salt']), true);
  assert.equal(matchesPantryStaple('flaky sea salt', ['kosher salt']), true, 'qualifiers are stripped from both sides');
  assert.equal(matchesPantryStaple('freshly ground black pepper', ['black pepper']), true);
  assert.equal(matchesPantryStaple('pepper', ['black pepper']), true);
  assert.equal(matchesPantryStaple('black pepper', ['pepper']), true);
  assert.equal(matchesPantryStaple('extra virgin olive oil', ['olive oil']), true);
  assert.equal(matchesPantryStaple('extra-virgin olive oil', ['Olive Oil']), true);
  assert.equal(matchesPantryStaple('salt and pepper', staples), true);
  assert.equal(matchesPantryStaple('salt & pepper', staples), true);
  assert.equal(matchesPantryStaple('salt, pepper', staples), true);
  assert.equal(matchesPantryStaple('garlic salt', ['salt']), false);
  assert.equal(matchesPantryStaple('bell pepper', ['pepper', 'black pepper']), false);
  assert.equal(matchesPantryStaple('salt and pepper', ['salt']), false, 'every part of a composite must be a staple');
  assert.equal(matchesPantryStaple('olive oil', []), false);
  assert.equal(matchesPantryStaple('', staples), false);
}

{
  // 3 + 6: aggregation skips water, ice and staples, merges unquantified lines, and shops for the top of a range.
  const staples = DEFAULT_STAPLES;
  const noWater = aggregateRecipes([
    recipe('w1', 'Soup', ['a splash of water', '2 carrots']),
    recipe('w2', 'Rice', ['1 cup water', '1 cup rice']),
    recipe('w3', 'Drink', ['ice', '2 limes']),
  ]);
  assert.deepEqual(noWater.map((item) => item.normalizedIngredient).sort(), ['carrot', 'lime', 'rice']);

  assert.equal(aggregateRecipes([recipe('s1', 'S1', ['salt and pepper to taste'])], {}, staples).length, 0, 'salt and pepper is covered by the staples');
  assert.equal(aggregateRecipes([recipe('p1', 'P1', ['Pepper']), recipe('p2', 'P2', ['Pepper'])], {}, staples).length, 0, 'unquantified pepper is a staple');

  const pepperRows = aggregateRecipes([recipe('p1', 'P1', ['Pepper']), recipe('p2', 'P2', ['Pepper']), recipe('p3', 'P3', ['pepper'])]);
  assert.equal(pepperRows.length, 1, 'three unquantified peppers become one row when staples are off');
  assert.equal(pepperRows[0].recipeContributions.length, 3);
  assert.equal(pepperRows[0].quantity, null);

  const saffron = aggregateRecipes([recipe('sf', 'Paella', ['pinch of saffron'])], {}, staples);
  assert.equal(saffron.length, 1);
  assert.equal(saffron[0].groceryCategory, 'Spices & Seasonings');
  assert.equal(saffron[0].unit, 'pinch');

  const garlic = aggregateRecipes([recipe('g1', 'G1', ['2-3 cloves garlic']), recipe('g2', 'G2', ['4 cloves garlic'])]);
  assert.equal(garlic.length, 1, 'ranges and plain counts of the same unit merge');
  assert.equal(formatRational(garlic[0].quantity), '7', 'a range shops for its upper bound');
  assert.equal(garlic[0].unit, 'clove');
  assert.equal(garlic[0].ingredientName, 'garlic');

  const parsley = aggregateRecipes([recipe('pa', 'PA', ['2 tbsp finely chopped parsley']), recipe('pb', 'PB', ['1 bunch parsley'])]);
  assert.equal(parsley.length, 2, 'different measures stay separate rows');
  assert(parsley.every((item) => item.normalizedIngredient === 'parsley'));
  assert(parsley.every((item) => item.ingredientName === 'parsley'), 'the shortest clean name is used');
  assert(itemFor(parsley, 'parsley', 'bunch'));
  assert(itemFor(parsley, 'parsley', 'tbsp'));

  // 3(e): a line with no amount joins the quantified row for the same ingredient rather than adding a second row.
  const garnish = aggregateRecipes([recipe('ga', 'GA', ['finely chopped parsley']), recipe('gb', 'GB', ['1 bunch parsley'])]);
  assert.equal(garnish.length, 1, 'an unquantified line joins the only quantified row');
  assert.equal(garnish[0].unit, 'bunch');
  assert.equal(formatRational(garnish[0].quantity), '1');
  assert.equal(garnish[0].recipeContributions.length, 2);
  const eggs = aggregateRecipes([recipe('e1', 'E1', ['2 large eggs']), recipe('e2', 'E2', ['3 eggs', 'Eggs, for brushing'])]);
  assert.equal(eggs.length, 1, '"Eggs, for brushing" joins the egg row');
  assert.equal(formatRational(eggs[0].quantity), '5');
  assert.equal(eggs[0].recipeContributions.length, 3);
  const mostContributions = aggregateRecipes([
    recipe('h1', 'H1', ['1 bunch parsley']), recipe('h2', 'H2', ['2 tbsp parsley']), recipe('h3', 'H3', ['1 tbsp parsley']), recipe('h4', 'H4', ['Parsley, for garnish']),
  ]);
  assert.equal(mostContributions.length, 2);
  assert.equal(itemFor(mostContributions, 'parsley', 'tbsp')?.recipeContributions.length, 3, 'with several quantified rows the garnish joins the busiest one');
  assert.equal(itemFor(mostContributions, 'parsley', 'bunch')?.recipeContributions.length, 1);

  const chickpeas = aggregateRecipes([recipe('c1', 'C1', ['1 (14 oz) can chickpeas']), recipe('c2', 'C2', ['1 tin chickpeas'])]);
  assert.equal(chickpeas.length, 1);
  assert.equal(formatRational(chickpeas[0].quantity), '2');
  assert.equal(chickpeas[0].unit, 'can');
  assert.equal(chickpeas[0].groceryCategory, 'Canned & Jarred');

  const mixed = aggregateRecipes([recipe('m1', 'M1', ['2 tbsp Parsley, finely chopped']), recipe('m2', 'M2', ['1 tbsp parsley'])]);
  assert.equal(mixed.length, 1, 'a review-free and a quantified line of the same measure merge');
  assert.equal(formatRational(mixed[0].quantity), '3');
  assert.equal(mixed[0].ingredientName, 'Parsley', 'ties keep the first casing');

  const scaledRange = aggregateRecipes([recipe('r1', 'R1', ['2-3 cloves garlic'], 4)], { r1: 8 });
  assert.equal(formatRational(scaledRange[0].quantity), '6', 'the upper bound scales with servings');
  assert.deepEqual(Object.keys(noWater[0]).sort(), [
    'checked', 'dateModified', 'groceryCategory', 'id', 'ingredientName', 'manual', 'normalizedIngredient', 'purchasedAt', 'quantity', 'recipeContributions', 'revision', 'unit',
  ], 'the grocery item shape is unchanged');
}

{
  // 4: display helpers.
  assert.equal(formatQuantityWithUnit(rational(7), 'clove'), '7 cloves');
  assert.equal(formatQuantityWithUnit(rational(3, 2), 'lb'), '1½ lb');
  assert.equal(formatQuantityWithUnit(rational(2), 'cup'), '2 cups');
  assert.equal(formatQuantityWithUnit(rational(1), 'cup'), '1 cup');
  assert.equal(formatQuantityWithUnit(rational(2), 'clove', rational(3)), '2–3 cloves');
  assert.equal(formatQuantityWithUnit(rational(1), 'tsp', rational(2)), '1–2 tsp');
  assert.equal(formatQuantityWithUnit(rational(3), 'each'), '3');
  assert.equal(formatQuantityWithUnit(null, 'cup'), '');
  assert.equal(formatQuantityWithUnit(rational(2), null), '2');

  const garlic = parseIngredientLine('- 2-3 cloves garlic, minced');
  assert.equal(formatIngredient(garlic), '2-3 cloves garlic, minced', 'at factor 1 the author’s phrasing survives without the bullet');
  assert.equal(formatIngredient(garlic, rational(1)), '2-3 cloves garlic, minced');
  assert.equal(formatIngredient(garlic, rational(2)), '4–6 cloves garlic, minced');
  assert.equal(formatIngredient(parseIngredientLine('1 cup flour'), rational(3)), '3 cups flour');
  assert.equal(formatIngredient(parseIngredientLine('1 cup flour'), rational(1, 2)), '½ cup flour');
  assert.equal(formatIngredient(parseIngredientLine('2 large eggs'), rational(2)), '4 large eggs');
  assert.equal(formatIngredient(parseIngredientLine('1 (14 oz) can chickpeas'), rational(2)), '2 cans chickpeas (14 oz)');
  assert.equal(formatIngredient(parseIngredientLine('1 tbsp olive oil'), rational(2)), '2 tbsp olive oil');
  assert.equal(formatIngredient(parseIngredientLine('Kosher salt'), rational(2)), 'Kosher salt', 'unquantified lines cannot scale');
  assert.equal(formatIngredient(parseIngredientLine('½ cup cream')), '½ cup cream', 'vulgar fractions are kept in the original');
  assert.equal(formatRational(parseIngredientLine('1½ cups flour').quantity), '1½');
}

{
  // 5: the Instagram caption from the task, end to end.
  const caption = [
    'Lunches That Last: Chicken Caesar Baked Wraps 🥙',
    'Ingredients (Serves 3–4)',
    'For the chicken tray bake:',
    '* 600g boneless, skinless chicken thighs, diced',
    '* 1 tin chickpeas, drained and rinsed',
    '* 1 tsp paprika',
    '* Spray oil or 1 tbsp olive oil',
    'Lighter Caesar dressing:',
    '* 2 tbsp Greek yoghurt',
    '* 1 tsp Dijon mustard',
    '* Pepper',
    '* Splash of water to loosen',
    'Method',
    '1. Roast the chicken and chickpeas for 25 minutes.',
    '2. Blend the dressing and toss everything together.',
  ].join('\n');
  const { draft, warnings } = parseRecipeText(caption);
  assert.equal(draft.title, 'Lunches That Last: Chicken Caesar Baked Wraps');
  assert.equal(draft.servings, 3, '"Serves 3–4" yields the lower bound');
  assert.equal(draft.description, '', 'the ingredient block must not be swallowed by the description');
  assert.equal(draft.ingredients.length, 8);
  assert.deepEqual(draft.ingredients.map((item) => item.section), [
    ...Array(4).fill('For the chicken tray bake'), ...Array(4).fill('Lighter Caesar dressing'),
  ]);
  const chicken = draft.ingredients[0];
  assert.equal(formatRational(chicken.quantity), '600');
  assert.equal(chicken.unit, 'g');
  assert.equal(chicken.ingredientName, 'boneless skinless chicken thighs');
  assert.equal(draft.ingredients[1].unit, 'can');
  assert.equal(draft.ingredients[3].needsReview, true, 'the spray-oil alternative asks for a look');
  assert.equal(draft.ingredients[6].toTaste, true);
  assert.equal(draft.ingredients[6].needsReview, false);
  const splash = draft.ingredients[7];
  assert.equal(splash.skipGrocery, true);
  assert.equal(splash.unit, 'splash');
  assert.equal(draft.instructions.length, 2);
  assert.deepEqual(draft.instructions.map((step) => step.text), [
    'Roast the chicken and chickpeas for 25 minutes.',
    'Blend the dressing and toss everything together.',
  ]);
  assert.equal(draft.instructions[0].timerMinutes, 25);
  assert.deepEqual(warnings, ['1 ingredient needs a quick review.']);
  const groceries = aggregateRecipes([draftToRecipe(draft)], {}, DEFAULT_STAPLES);
  assert.equal(groceries.some((item) => item.normalizedIngredient === 'water'), false);
  assert.equal(groceries.some((item) => item.normalizedIngredient === 'pepper'), false);
  assert.equal(groceries.some((item) => item.normalizedIngredient === 'cooking spray'), false, 'spray oil is a pantry staple');
}

{
  // 5: heading variants, title hygiene and unnumbered steps.
  const chili = parseRecipeText('Easy Weeknight Chili 🔥🔥\nSo good you\'ll make it twice.\nServes 4\nWhat you\'ll need:\n1 lb ground beef\n1 onion\nDirections 👇\nBrown the beef.\nAdd the onion and simmer.\n#chili #dinner');
  assert.equal(chili.draft.title, 'Easy Weeknight Chili');
  assert.equal(chili.draft.servings, 4);
  assert.equal(chili.draft.description, 'So good you\'ll make it twice.');
  assert.deepEqual(chili.draft.ingredients.map((item) => item.ingredientName), ['ground beef', 'onion']);
  assert.deepEqual(chili.draft.instructions.map((step) => step.text), ['Brown the beef.', 'Add the onion and simmer.'], 'unnumbered lines after a heading are steps');

  const shrimp = parseRecipeText('Serves 2\nGarlic Butter Shrimp 🍤\nINGREDIENTS 👇\n1 lb shrimp\n3 cloves garlic\nHow to make it\nStep 1: Melt butter.\nStep 2: Add shrimp.');
  assert.equal(shrimp.draft.title, 'Garlic Butter Shrimp', 'a "Serves N" line is never the title');
  assert.equal(shrimp.draft.servings, 2);
  assert.equal(shrimp.draft.ingredients.length, 2);
  assert.deepEqual(shrimp.draft.instructions.map((step) => step.text), ['Melt butter.', 'Add shrimp.']);

  const traybake = parseRecipeText('#mealprep https://example.com/x\nSheet Pan Chicken ✨\n600g chicken thighs\n2 tbsp olive oil\nSteps\nRoast everything.');
  assert.equal(traybake.draft.title, 'Sheet Pan Chicken', 'hashtag and url lines are skipped for the title');
  assert.equal(traybake.draft.ingredients.length, 2, 'a metric no-space line switches to ingredients without a heading');
  assert.equal(traybake.draft.description, '');
  assert.deepEqual(traybake.draft.instructions.map((step) => step.text), ['Roast everything.']);

  for (const heading of ['Ingredients (Serves 3–4)', 'INGREDIENTS 👇', "What you'll need:", 'You will need', 'Shopping list']) {
    const parsed = parseRecipeText(`Test Dish\n${heading}\n1 cup rice\nMethod\nCook it.`);
    assert.equal(parsed.draft.ingredients.length, 1, `"${heading}" should start the ingredient list`);
    assert.equal(parsed.draft.instructions.length, 1, `"${heading}" should not block the method heading`);
  }
  for (const heading of ['Method', 'Directions 👇', 'How to make it', 'Steps', 'Preparation', 'Instructions:']) {
    const parsed = parseRecipeText(`Test Dish\nIngredients\n1 cup rice\n${heading}\nCook it.\nServe warm.`);
    assert.deepEqual(parsed.draft.instructions.map((step) => step.text), ['Cook it.', 'Serve warm.'], `"${heading}" should start the steps`);
  }
  const sections = parseRecipeText('Bowls\nFor the chicken tray bake:\n1 lb chicken\nLighter Caesar dressing:\n2 tbsp yogurt\nMethod\nMix.');
  assert.deepEqual(sections.draft.ingredients.map((item) => item.section), ['For the chicken tray bake', 'Lighter Caesar dressing']);
  const numberedIngredients = parseRecipeText('Pancakes\nIngredients\n1. 2 cups flour\n2. 1 cup milk\nMethod\n1. Whisk.\n2. Fry.');
  assert.equal(numberedIngredients.draft.ingredients.length, 2, 'numbered ingredient lines stay ingredients');
  assert.equal(numberedIngredients.draft.instructions.length, 2);
}

{
  // Review M1: digits are never emoji, so numbered titles survive and an ingredient line is never promoted to the title.
  for (const [first, title] of [
    ['5-Minute Hummus 🥣', '5-Minute Hummus'], ['Chicken 65', 'Chicken 65'], ['Taco Tuesday 🌮🌮', 'Taco Tuesday'],
    ['3 Ingredient Banana Pancakes', '3 Ingredient Banana Pancakes'], ['Best Brownies 2.0', 'Best Brownies 2.0'],
    ['#1 Weeknight Chili', '#1 Weeknight Chili'], ['🔥 One Pot Pasta 🔥', 'One Pot Pasta'],
  ] as const) {
    const parsed = parseRecipeText(`${first}\nIngredients\n1 lb beef\nMethod\nCook.`);
    assert.equal(parsed.draft.title, title, `title of "${first}"`);
    assert.equal(parsed.draft.ingredients.length, 1, `"${first}" must not consume the ingredient line`);
  }
  const untitled = parseRecipeText('Ingredients\n1 lb beef\nMethod\nCook.');
  assert.equal(untitled.draft.title, 'Untitled recipe', 'nothing after the ingredients heading is a title');
  assert.equal(untitled.draft.ingredients.length, 1);
  const bare = parseRecipeText('600g chicken thighs\n2 tbsp olive oil\n1 onion\nMethod\nRoast.');
  assert.equal(bare.draft.title, 'Untitled recipe', 'a measured ingredient line ends the title search');
  assert.equal(bare.draft.ingredients.length, 3);
}

{
  // Review M2: a lone qualifier before "or" shares the noun that follows; unknown primaries keep the phrase and ask for a look.
  expectLine('1 cup fresh or frozen corn', { quantity: '1', unit: 'cup', ingredientName: 'fresh corn', normalizedIngredient: 'fresh corn', groceryCategory: 'Produce', note: 'or frozen corn', needsReview: false });
  expectLine('1 lb fresh or frozen shrimp', { ingredientName: 'fresh shrimp', groceryCategory: 'Meat & Seafood', note: 'or frozen shrimp', needsReview: false });
  expectLine('1 red or yellow bell pepper', { quantity: '1', unit: 'each', ingredientName: 'red bell pepper', groceryCategory: 'Produce', note: 'or yellow bell pepper', needsReview: false });
  expectLine('2 cups sweet or russet potatoes', { ingredientName: 'sweet potatoes', normalizedIngredient: 'sweet potato', groceryCategory: 'Produce', needsReview: false });
  expectLine('1 cup oat or almond milk', { ingredientName: 'oat milk', groceryCategory: 'Dairy & Eggs', note: 'or almond milk' });
  expectLine('4 cups chicken or vegetable broth', { ingredientName: 'chicken broth', groceryCategory: 'Canned & Jarred', note: 'or vegetable broth' });
  expectLine('1 tbsp butter or olive oil', { ingredientName: 'butter', groceryCategory: 'Dairy & Eggs', note: 'or olive oil', needsReview: false });
  expectLine('2 tbsp honey or maple syrup', { ingredientName: 'honey', groceryCategory: 'Pantry', note: 'or maple syrup' });
  expectLine('1 cup unobtainium or whatever', { ingredientName: 'unobtainium or whatever', groceryCategory: 'Other', note: null, needsReview: true });
  expectLine('2 large or 1 small onion', { ingredientName: 'large or 1 small onion', groceryCategory: 'Produce', needsReview: true, descriptor: null });
  const corn = aggregateRecipes([recipe('corn', 'Corn', ['1 cup fresh or frozen corn'])]);
  assert.deepEqual(corn.map((item) => [item.ingredientName, item.groceryCategory]), [['fresh corn', 'Produce']], 'no "fresh" row in Other');
}

{
  // Review M3: unnumbered steps that start with a verb and a duration are steps, not metadata.
  const smashed = parseRecipeText([
    'Crispy Smashed Potatoes', 'Ingredients', '1.5kg baby potatoes', 'Method',
    'Boil the potatoes for 15 minutes until tender.', 'Smash each one with a glass and drizzle with oil.',
    'Bake 25 minutes until golden.', 'Rest 5 minutes before serving.', 'Serves 4', 'Total time: 1 hour 15 minutes',
  ].join('\n'));
  assert.deepEqual(smashed.draft.instructions.map((step) => step.text), [
    'Boil the potatoes for 15 minutes until tender.', 'Smash each one with a glass and drizzle with oil.',
    'Bake 25 minutes until golden.', 'Rest 5 minutes before serving.',
  ], 'every Method line becomes a step; the trailing yield and timing lines do not');
  assert.equal(smashed.draft.instructions[2].timerMinutes, 25);
  assert.equal(smashed.draft.servings, 4);
  assert.deepEqual(smashed.warnings, []);
  const timed = parseRecipeText('Dish\nPrep time: 10 minutes\nCook time: 20 minutes\nIngredients\n1 cup rice\nMethod\nCook time: 20 minutes\nPrep 5 min | Cook 10 min\nSimmer the rice.\nBake 25 minutes.');
  assert.deepEqual(timed.draft.instructions.map((step) => step.text), ['Simmer the rice.', 'Bake 25 minutes.'], 'whole-line timings are skipped inside the steps too');
  assert.equal(timed.draft.prepTime, 10);
  assert.equal(timed.draft.cookTime, 20);
}

{
  // Review M4: "Full recipe (link in bio)" is promotion, not a heading, and a multi-word heading is never split in the middle.
  const shrimp = parseRecipeText([
    'Garlic Butter Shrimp 🍤', 'Full recipe (link in bio)', 'Made this for dinner and it was incredible, 15 minutes start to finish.',
    'Ingredients:', '1 lb shrimp', '3 cloves garlic', 'How to make it:', 'Melt the butter.', 'Add the shrimp.',
  ].join('\n'));
  assert.equal(shrimp.draft.title, 'Garlic Butter Shrimp');
  assert.equal(shrimp.draft.description, 'Made this for dinner and it was incredible, 15 minutes start to finish.');
  assert.deepEqual(shrimp.draft.ingredients.map((item) => item.ingredientName), ['shrimp', 'garlic'], 'no prose line becomes an ingredient');
  assert.deepEqual(shrimp.draft.instructions.map((step) => step.text), ['Melt the butter.', 'Add the shrimp.']);
  const marker = parseRecipeText('Garlic Butter Shrimp 🍤\nFull recipe:\n1 lb shrimp\n3 cloves garlic\nMethod\nCook.');
  assert.equal(marker.draft.description, '', '"Full recipe:" is skipped rather than split into "Full" + "recipe:"');
  assert.equal(marker.draft.ingredients.length, 2);
  const arrow = parseRecipeText('Garlic Butter Shrimp 🍤\nRecipe 👇\n1 lb shrimp\nMethod\nCook.');
  assert.equal(arrow.draft.description, '');
  assert.equal(arrow.draft.ingredients.length, 1);
  const inline = parseRecipeText('Garlic Butter Shrimp\nIngredients: 1 lb shrimp How to make it: Melt butter and add the shrimp.');
  assert.equal(inline.draft.ingredients.length, 1);
  assert.deepEqual(inline.draft.instructions.map((step) => step.text), ['Melt butter and add the shrimp.'], 'the inline heading is consumed whole');
  const promoTail = parseRecipeText('Garlic Butter Shrimp\nIngredients\n1 lb shrimp\nFull recipe on my blog, link in bio!\nMethod\nCook.');
  assert.equal(promoTail.draft.ingredients.length, 1, 'a promo line is skipped, not parsed as an ingredient');
  assert.equal(promoTail.draft.instructions.length, 1, 'a promo line between blocks does not stop the parse');
  const promoTitle = parseRecipeText('Weeknight Pasta 🍝 Full recipe below 👇\nIngredients\n12 oz spaghetti\nSteps\n1. Boil pasta.');
  assert.equal(promoTitle.draft.title, 'Weeknight Pasta', 'an inline promo tail is not part of the title');
  assert.equal(promoTitle.draft.ingredients.length, 1);
  const salmon = parseRecipeText('Save this one! 🔥\nSticky Honey Garlic Salmon\nServes 2 | Prep 5 min | Cook 12 min\nHere\'s what you need:\n2 salmon fillets\n2 tbsp honey\nHere\'s how to make it:\nMix honey and garlic.\nBake 12 minutes.\nFollow @me for more');
  assert.equal(salmon.draft.title, 'Sticky Honey Garlic Salmon', '"Save this one!" is social noise, not the title');
  assert.deepEqual([salmon.draft.servings, salmon.draft.prepTime, salmon.draft.cookTime], [2, 5, 12]);
  assert.equal(salmon.draft.ingredients.length, 2, '"Here\'s what you need:" is one ingredient heading');
  assert.deepEqual(salmon.draft.instructions.map((step) => step.text), ['Mix honey and garlic.', 'Bake 12 minutes.']);
}

{
  // Review m5: caption prose ending in ":" stays in the description; real section openers still start the list.
  const potatoes = parseRecipeText('Crispy Smashed Potatoes 🥔✨\nThese are SO good. Trust me on this one:\nYou will need 👇\n1.5kg baby potatoes\nMethod\nBoil.');
  assert.equal(potatoes.draft.description, 'These are SO good. Trust me on this one:');
  assert.deepEqual(potatoes.draft.ingredients.map((item) => [item.section, item.ingredientName]), [[null, 'baby potatoes']]);
  const intro = parseRecipeText('Bowls\nWhat I used:\n1 lb chicken\n2 tbsp yogurt\nMethod\nMix.');
  assert.equal(intro.draft.description, '', 'prose that introduces the list switches mode');
  assert.deepEqual(intro.draft.ingredients.map((item) => item.section), [null, null], 'but it is not a section name');
  assert.deepEqual(intro.draft.instructions.map((step) => step.text), ['Mix.']);
  const madeIt = parseRecipeText('Bowls\nHere\'s how I made it:\n1 lb chicken\n2 tbsp yogurt\nMethod\nMix.');
  assert.equal(madeIt.draft.description, '', '"Here\'s how I made it:" is one heading, not "Here\'s" + "how I made it:"');
  assert.deepEqual(madeIt.draft.ingredients.map((item) => item.ingredientName), ['chicken', 'yogurt'], 'measured lines right after it are ingredients');
  assert.deepEqual(madeIt.draft.instructions.map((step) => step.text), ['Mix.']);
  const stepsIntro = parseRecipeText('Bowls\nIngredients\n1 lb chicken\nHere\'s how I made it:\nSear the chicken.\nServe.');
  assert.deepEqual(stepsIntro.draft.instructions.map((step) => step.text), ['Sear the chicken.', 'Serve.'], 'after the ingredients it starts the steps');
  const noun = parseRecipeText('Bowls\nDressing:\n2 tbsp yogurt\nFor the chicken:\n1 lb chicken\nMethod\nMix.');
  assert.deepEqual(noun.draft.ingredients.map((item) => item.section), ['Dressing', 'For the chicken']);
  const prose = parseRecipeText('Bowls\nA few things I always keep on hand:\nRice, beans and a good hot sauce.\nIngredients\n1 cup rice\nMethod\nMix.');
  assert.equal(prose.draft.description, 'A few things I always keep on hand: Rice, beans and a good hot sauce.');
  assert.equal(prose.draft.ingredients.length, 1);
}

{
  // Review m6: US container sizes without parentheses merge with the parenthesized form.
  expectLine('1 15 oz can black beans', { quantity: '1', unit: 'can', ingredientName: 'black beans', normalizedIngredient: 'black beans', note: '15 oz', groceryCategory: 'Canned & Jarred' });
  expectLine('2 14.5-oz cans diced tomatoes', { quantity: '2', unit: 'can', ingredientName: 'diced tomatoes', normalizedIngredient: 'diced tomato', note: '14.5 oz', groceryCategory: 'Canned & Jarred' });
  expectLine('1 28-ounce can whole peeled tomatoes', { quantity: '1', unit: 'can', ingredientName: 'whole peeled tomatoes', note: '28 ounce' });
  expectLine('2 400g tins chickpeas', { quantity: '2', unit: 'can', ingredientName: 'chickpeas', note: '400 g', groceryCategory: 'Canned & Jarred' });
  expectLine('1 8 oz package cream cheese', { quantity: '1', unit: 'package', ingredientName: 'cream cheese', note: '8 oz', groceryCategory: 'Dairy & Eggs' });
  const beans = aggregateRecipes([recipe('b1', 'B1', ['1 15 oz can black beans']), recipe('b2', 'B2', ['1 (15 oz) can black beans'])]);
  assert.equal(beans.length, 1);
  assert.equal(formatRational(beans[0].quantity), '2');
  assert.equal(beans[0].unit, 'can');
}

{
  // Review m7: NYT Cooking's bare "Step 1" lines label the next line instead of becoming steps.
  const nyt = parseRecipeText('Roast Chicken\nYield: 4 servings\nTime: 1 hour 30 minutes\nINGREDIENTS\n1 whole chicken\nKosher salt\nPREPARATION\nStep 1\nHeat oven to 425 degrees.\nStep 2\nSeason the chicken.\nStep 3\nRoast for 1 hour.');
  assert.equal(nyt.draft.title, 'Roast Chicken');
  assert.equal(nyt.draft.servings, 4);
  assert.equal(nyt.draft.ingredients.length, 2);
  assert.deepEqual(nyt.draft.instructions.map((step) => step.text), ['Heat oven to 425 degrees.', 'Season the chicken.', 'Roast for 1 hour.']);
  const unlabeled = parseRecipeText('Roast Chicken\nIngredients\n1 whole chicken\nStep 1\nHeat oven to 425 degrees.\nStep 2\nSeason the chicken.');
  assert.deepEqual(unlabeled.draft.instructions.map((step) => step.text), ['Heat oven to 425 degrees.', 'Season the chicken.'], 'a bare "Step 1" also starts the steps without a heading');
}

{
  // Review m9: a weight of chopped/peeled tomatoes is the tinned product; a count or a cup of chopped tomatoes is fresh.
  expectLine('400g chopped tomatoes', { quantity: '400', unit: 'g', ingredientName: 'chopped tomatoes', normalizedIngredient: 'chopped tomato', groceryCategory: 'Canned & Jarred', preparation: null });
  expectLine('800g peeled tomatoes', { ingredientName: 'peeled tomatoes', groceryCategory: 'Canned & Jarred' });
  expectLine('14 oz diced tomatoes', { ingredientName: 'diced tomatoes', groceryCategory: 'Canned & Jarred' });
  expectLine('400g tin chopped tomatoes', { ingredientName: 'chopped tomatoes', note: 'tin', groceryCategory: 'Canned & Jarred' });
  expectLine('2 chopped tomatoes', { quantity: '2', unit: 'each', ingredientName: 'tomatoes', preparation: 'chopped', groceryCategory: 'Produce' });
  expectLine('1 cup chopped tomatoes', { ingredientName: 'tomatoes', preparation: 'chopped', groceryCategory: 'Produce' });
  expectLine('1 lb tomatoes, chopped', { ingredientName: 'tomatoes', preparation: 'chopped', groceryCategory: 'Produce' });
}

{
  // Review m11: odd phrasings get sensible names.
  expectLine('3 cloves, minced', { quantity: '3', unit: 'clove', ingredientName: 'cloves', preparation: 'minced', needsReview: true });
  expectLine('2 rib eye steaks', { quantity: '2', unit: 'each', ingredientName: 'rib eye steaks', normalizedIngredient: 'rib eye steak', groceryCategory: 'Meat & Seafood' });
  expectLine('2 ribs celery', { quantity: '2', unit: 'rib', ingredientName: 'celery' });
  expectLine('1 jalapeño, seeds removed', { quantity: '1', unit: 'each', ingredientName: 'jalapeño', normalizedIngredient: 'jalapeño', preparation: 'seeds removed', groceryCategory: 'Produce' });
  expectLine('2 jalapeños, stems and seeds removed', { ingredientName: 'jalapeños', preparation: 'stems and seeds removed' });
  expectLine('1 packed cup brown sugar', { quantity: '1', unit: 'cup', ingredientName: 'brown sugar', normalizedIngredient: 'brown sugar', note: 'packed', groceryCategory: 'Pantry' });
  expectLine('1 cup packed brown sugar', { quantity: '1', unit: 'cup', ingredientName: 'brown sugar', note: 'packed' });
  expectLine('1 cup firmly packed brown sugar', { unit: 'cup', ingredientName: 'brown sugar', note: 'firmly packed' });
  expectLine('1 heaping tbsp miso', { quantity: '1', unit: 'tbsp', ingredientName: 'miso', note: 'heaping' });
  expectLine('1 bunch cilantro, leaves and stems chopped', { quantity: '1', unit: 'bunch', ingredientName: 'cilantro', normalizedIngredient: 'cilantro', preparation: 'leaves and stems chopped' });
  expectLine('1 lemon, zest and juice', { ingredientName: 'lemon', note: 'zest and juice' });
  expectLine('1 lb shrimp, tails removed', { ingredientName: 'shrimp', preparation: 'tails removed' });
  const sugar = aggregateRecipes([recipe('s1', 'S1', ['1 packed cup brown sugar']), recipe('s2', 'S2', ['1/2 cup brown sugar'])]);
  assert.equal(sugar.length, 1, 'packed and plain cups of brown sugar aggregate');
  assert.equal(formatRational(sugar[0].quantity), '1½');
}

{
  // Review m8 + m12: source hygiene — no invisible characters in the parser, and the staples mirror matches the seed.
  const domainSource = readFileSync(new URL('../lib/domain.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(domainSource, /[   ️⃣‍​⁠]/, 'regexes must spell invisible characters as \\u escapes');
  const seedSource = readFileSync(new URL('../lib/seed.ts', import.meta.url), 'utf8');
  const seedStaples = [...(seedSource.match(/pantryStaples:\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(seedStaples, DEFAULT_STAPLES, 'DEFAULT_STAPLES must mirror SEED_PREFERENCES.pantryStaples');
  assert.match(seedSource, /excludePantryStaples: true/);
}

{
  // Audit 1: vulgar fractions are mapped to ASCII before NFKC (which would turn "½" into "1⁄2"), in the parser and in the keys.
  expectLine('½ cup cream', { quantity: '½', unit: 'cup', ingredientName: 'cream' });
  expectLine('1½ cups flour', { quantity: '1½', unit: 'cup', ingredientName: 'flour' });
  expectLine('1 ½ cups flour', { quantity: '1½', unit: 'cup', ingredientName: 'flour' });
  expectLine('2 ¾ tsp salt', { quantity: '2¾', unit: 'tsp', ingredientName: 'salt' });
  expectLine('⅓ cup', { quantity: '⅓', unit: 'cup' });
  expectLine('⅙ cup sugar', { quantity: '⅙', unit: 'cup', ingredientName: 'sugar' });
  expectLine('1⅕ tsp x', { quantity: '1⅕', unit: 'tsp' });
  assert.equal(parseIngredientLine('2 ¾ tsp salt').quantity?.numerator, 11);
  assert.equal(normalizeIngredientName('½ lemon'), '1/2 lemon', 'no U+2044 fraction slash in keys');
  assert.equal(normalizeIngredientName('1½ lemon'), '1 1/2 lemon');
  assert.doesNotMatch(normalizeIngredientName('⅓ cup oats'), /⁄/);
}

{
  // Audit 2: formatRational keeps the sign, spaces a glyph-less fraction from the whole number, and knows sixths and fifths.
  assert.equal(formatRational(rational(7, 6)), '1⅙');
  assert.equal(formatRational(rational(35, 16)), '2 3/16');
  assert.equal(formatRational(rational(-1, 2)), '-½');
  assert.equal(formatRational(rational(-3, 2)), '-1½');
  assert.equal(formatRational(rational(-2)), '-2');
  assert.deepEqual([1, 5].map((n) => formatRational(rational(n, 6))), ['⅙', '⅚']);
  assert.deepEqual([1, 2, 3, 4].map((n) => formatRational(rational(n, 5))), ['⅕', '⅖', '⅗', '⅘']);
  assert.equal(formatRational(rational(13, 12)), '1 1/12');
  assert.equal(formatShoppingQuantity(rational(7, 12)), '≈⅝', 'rounded to the nearest eighth');
  assert.equal(formatShoppingQuantity(rational(2, 3)), '⅔', 'a third is exact');
  assert.equal(formatShoppingQuantity(rational(5, 12)), '≈⅜');
  assert.equal(formatShoppingQuantity(rational(9, 4)), '2¼');
  assert.equal(formatShoppingQuantity(rational(1, 6)), '≈⅛');
  assert.equal(formatShoppingQuantity(rational(1, 100)), '≈⅛', 'a trace never rounds to nothing');
  assert.equal(formatShoppingQuantity(rational(3)), '3');
  assert.equal(formatShoppingQuantity(null), '');
}

{
  // Audit 3: grocery display units. Promotion within the family regardless of contributed units; dozen only when a
  // recipe counted in dozens and the total is whole; counts are bought whole while the contributions stay exact.
  const show = (perRecipe: string[][]): string[] => aggregateRecipes(perRecipe.map((lines, index) => recipe(`unit${index}`, `Unit ${index}`, lines)))
    .map((item) => `${formatRational(item.quantity)} ${item.unit}`);
  assert.deepEqual(show([['12 eggs'], ['3 eggs']]), ['15 each'], 'never a dozen unless a recipe said dozen');
  assert.deepEqual(show([['1 dozen eggs'], ['3 eggs']]), ['15 each'], '15 is not a whole number of dozens');
  assert.deepEqual(show([['1 dozen eggs'], ['1 dozen eggs']]), ['2 dozen']);
  assert.deepEqual(show([['½ onion'], ['¼ onion']]), ['1 each'], 'three quarters of an onion is one onion');
  assert.deepEqual(show([['1 tsp salt'], ['2 tsp salt']]), ['1 tbsp']);
  assert.deepEqual(show([['2 tbsp oil'], ['2 tbsp oil']]), ['¼ cup']);
  assert.deepEqual(show([['8 oz cheese'], ['8 oz cheese']]), ['1 lb']);
  assert.deepEqual(show([['500 g flour'], ['500 g flour']]), ['1 kg']);
  assert.deepEqual(show([['500 ml milk'], ['500 ml milk']]), ['1 l']);
  assert.deepEqual(show([['6 tbsp oil'], ['1 tsp oil']]), ['6⅓ tbsp'], 'the smaller unit when the larger one would be 19/48');
  assert.deepEqual(show([['7 tbsp oil'], ['2 tbsp oil']]), ['9 tbsp'], '9/16 cup is never shown');
  assert.deepEqual(show([['1 tsp vanilla']]), ['1 tsp'], 'never ⅓ tbsp');
  assert.deepEqual(show([['4 oz cheese']]), ['4 oz'], 'never ¼ lb');
  assert.deepEqual(show([['2 cups stock'], ['3 cups stock']]), ['5 cup'], 'quarts only when a recipe used them');
  assert.deepEqual(show([['1 quart stock'], ['2 cups stock']]), ['1½ quart']);
  const halved = aggregateRecipes([recipe('halved', 'Halved', ['2 cloves garlic', '1 onion', '3 tbsp parsley'], 4)], { halved: 1 });
  assert.equal(formatRational(itemFor(halved, 'garlic')?.quantity ?? null), '1', '½ clove is bought as one clove');
  assert.equal(formatRational(itemFor(halved, 'garlic')?.recipeContributions[0].quantity ?? null), '½', 'the contribution keeps the exact amount');
  assert.equal(formatRational(itemFor(halved, 'onion')?.quantity ?? null), '1');
  assert.deepEqual([formatRational(itemFor(halved, 'parsley')?.quantity ?? null), itemFor(halved, 'parsley')?.unit], ['2¼', 'tsp'], '¾ tbsp is shown as the smaller unit, never rounded up');
}

{
  // Audit 4: everything after the first comma is a preparation unless it is a note, a shared qualifier or another seasoning.
  expectLine('2 large eggs, beaten', { ingredientName: 'eggs', normalizedIngredient: 'egg', preparation: 'beaten', descriptor: 'large', groceryCategory: 'Dairy & Eggs' });
  expectLine('boneless, skinless chicken thighs', { ingredientName: 'boneless skinless chicken thighs', normalizedIngredient: 'boneless skinless chicken thigh', preparation: null, groceryCategory: 'Meat & Seafood' });
  expectLine('2 fresh, ripe tomatoes', { ingredientName: 'fresh ripe tomatoes', preparation: null, groceryCategory: 'Produce' });
  expectLine('2 tbsp butter, cold', { ingredientName: 'butter', preparation: 'cold', groceryCategory: 'Dairy & Eggs' });
  expectLine('1 avocado, ripe', { ingredientName: 'avocado', preparation: 'ripe' });
  expectLine('1 cup rice, uncooked', { ingredientName: 'rice', preparation: 'uncooked' });
  expectLine('1 onion, red', { ingredientName: 'onion', preparation: 'red' });
  expectLine('Salt, pepper', { ingredientName: 'Salt and pepper', normalizedIngredient: 'salt and pepper', toTaste: true, needsReview: false, groceryCategory: 'Spices & Seasonings' });
  expectLine('2 limes, 1 juiced and 1 cut into wedges', { ingredientName: 'limes', note: '1 juiced and 1 cut into wedges', preparation: null });
  expectLine('1 lb beef, such as chuck', { ingredientName: 'beef', note: 'such as chuck' });
  assert.equal(aggregateRecipes([recipe('cold', 'Cold', ['2 tbsp butter, cold'])])[0].normalizedIngredient, 'butter');
}

{
  // Audit 5 + 6: punctuation and alternate measures after the unit; glued units; decimals with a point or a comma.
  expectLine('2 cups, divided', { quantity: '2', unit: 'cup', preparation: 'divided', needsReview: true });
  expectLine('1 cup/240 ml milk', { quantity: '1', unit: 'cup', ingredientName: 'milk', note: '240 ml', needsReview: false });
  expectLine('1 cup (240 ml) milk', { quantity: '1', unit: 'cup', ingredientName: 'milk', note: '240 ml' });
  expectLine('1 cup + 2 tbsp flour', { quantity: '18', unit: 'tbsp', ingredientName: 'flour', note: '1 cup + 2 tbsp', needsReview: false });
  expectLine('2 tbsp. butter', { quantity: '2', unit: 'tbsp', ingredientName: 'butter' });
  expectLine('2 Tbsp butter', { quantity: '2', unit: 'tbsp', ingredientName: 'butter' });
  expectLine('1 tspn salt', { quantity: '1', unit: 'tsp', ingredientName: 'salt' });
  for (const [line, quantity, unit] of [['250ml milk', '250', 'ml'], ['400g flour', '400', 'g'], ['1.5kg flour', '1½', 'kg'], ['2T sugar', '2', 'tbsp']] as const) {
    expectLine(line, { quantity, unit, needsReview: false });
  }
  expectLine('0.33 cup oil', { quantity: '⅓', unit: 'cup', ingredientName: 'oil' });
  expectLine('0.67 cup oil', { quantity: '⅔' });
  expectLine('.5 cup sugar', { quantity: '½', unit: 'cup', ingredientName: 'sugar', needsReview: false });
  expectLine('1,5 kg flour', { quantity: '1½', unit: 'kg', ingredientName: 'flour', needsReview: false });
  expectLine('1.33 cups flour', { quantity: '1⅓', unit: 'cup' });
  expectLine('0.3 cup milk', { quantity: '3/10' }, null);
  expectLine('1,000 g flour', { quantity: '1000', unit: 'g', ingredientName: 'flour' });
  expectLine('2,25 dl cream', { quantity: '2¼' });
}

{
  // Audit 7 + 8: size words before the unit become the descriptor; a line that names only a measure stays off the list.
  expectLine('1 large bunch kale', { quantity: '1', unit: 'bunch', ingredientName: 'kale', descriptor: 'large', note: null });
  expectLine('1 heaping tbsp sugar', { quantity: '1', unit: 'tbsp', ingredientName: 'sugar', note: 'heaping', descriptor: null });
  expectLine('small bunch coriander', { quantity: '1', unit: 'bunch', normalizedIngredient: 'cilantro', groceryCategory: 'Produce', descriptor: 'small' });
  expectLine('1 small bunch parsley', { unit: 'bunch', ingredientName: 'parsley', descriptor: 'small' });
  expectLine('1 medium head cauliflower', { unit: 'head', ingredientName: 'cauliflower', descriptor: 'medium', groceryCategory: 'Produce' });
  expectLine('1 tsp coriander', { normalizedIngredient: 'coriander', groceryCategory: 'Spices & Seasonings' });
  assert.equal(formatIngredient(parseIngredientLine('1 large bunch kale'), rational(2)), '2 large bunches kale');
  assert.equal(formatIngredient(parseIngredientLine('1 large onion'), rational(3)), '3 large onion');
  for (const line of ['3 cups', '1/3 cup', '1 1/2 teaspoons', '2 tbsp']) {
    const parsed = expectLine(line, { needsReview: true, skipGrocery: true });
    assert(parsed.confidence <= 0.4, `"${line}" confidence ${parsed.confidence}`);
    assert.notEqual(parsed.normalizedIngredient, normalizeIngredientName(line), `"${line}" must not be keyed by its own text`);
  }
  assert.equal(aggregateRecipes([recipe('measure', 'Measure', ['3 cups', '1 cup rice'])]).length, 1, 'a measure-only line never becomes a grocery row');
}

{
  // Audit 9: section headings without a trailing colon.
  for (const heading of ['FOR THE SAUCE', 'For the dressing', 'Topping', 'To serve', 'Sauce:', 'Marinade', 'Garnish', 'DRY INGREDIENTS', 'Lighter Caesar dressing:', '- For the crust', 'TOPPINGS 👇']) {
    assert(isIngredientSectionHeading(heading), `"${heading}" is a section heading`);
  }
  for (const line of ['Salt', 'SALT', 'Olive oil', 'OLIVE OIL', 'WATER', 'Pinch of salt', 'Lime wedges, to serve', 'Juice of 1 lemon', '2 cups flour', '½ cup cream', 'For the best results use the freshest basil you can find', 'Fresh basil', 'Method is in the caption!']) {
    assert(!isIngredientSectionHeading(line), `"${line}" is not a section heading`);
  }
  for (const heading of ['FOR THE SAUCE', 'For the dressing', 'Topping', 'To serve', 'Marinade']) {
    const parsed = parseRecipeText(`Dish\nIngredients\n1 cup rice\n${heading}\n2 tbsp soy sauce\nMethod\nCook.`);
    assert.deepEqual(parsed.draft.ingredients.map((item) => [item.ingredientName, item.section]), [['rice', null], ['soy sauce', heading]], `"${heading}" names the group`);
    assert.deepEqual(parsed.draft.instructions.map((step) => step.text), ['Cook.']);
  }
  const inline = parseRecipeText('Dish\nIngredients\n1 cup rice\nTo serve: lime wedges\nMethod\nCook.');
  assert.deepEqual(inline.draft.ingredients.map((item) => [item.ingredientName, item.section]), [['rice', null], ['lime wedges', 'To serve']]);
  const loud = parseRecipeText('Dish\nIngredients\n1 cup rice\nSALT\nOLIVE OIL\nMethod\nCook.');
  assert.deepEqual(loud.draft.ingredients.map((item) => item.ingredientName), ['rice', 'SALT', 'OLIVE OIL'], 'capitals alone do not make an ingredient a heading');
  const prose = parseRecipeText('Dish\nFor real though this one is a keeper\nIngredients\n1 cup rice\nMethod\nCook.');
  assert.equal(prose.draft.description, 'For real though this one is a keeper', 'description prose is not a section heading');
}

{
  // Audit 10 + 11: "or" ranges; the optional prefix and suffix.
  expectLine('2 or 3 cloves garlic', { quantity: '2', quantityMax: '3', unit: 'clove', ingredientName: 'garlic', approximate: true, needsReview: false });
  expectLine('optional: 1 tsp chili flakes', { quantity: '1', unit: 'tsp', ingredientName: 'chili flakes', optional: true, groceryCategory: 'Spices & Seasonings' });
  expectLine('Optional - fresh herbs', { ingredientName: 'fresh herbs', optional: true });
  expectLine('1 tsp chili flakes (optional)', { ingredientName: 'chili flakes', optional: true, note: null });
  expectLine('1 cup walnuts, optional', { ingredientName: 'walnuts', optional: true });
}

{
  // Audit 12: deterministic grocery ids.
  const recipes = [recipe('ida', 'A', ['2 onions', '1 cup milk', 'Parsley, for garnish']), recipe('idb', 'B', ['1 onion', '2 tbsp parsley'])];
  const first = aggregateRecipes(recipes).map((item) => item.id);
  const second = aggregateRecipes(recipes).map((item) => item.id);
  assert.deepEqual(first, second, 'the same recipes always mint the same ids');
  assert.equal(new Set(first).size, first.length, 'ids are unique within a list');
  for (const id of first) assert.match(id, /^grocery_[0-9a-f]{8}$/);
  const onionOnly = aggregateRecipes([recipe('idc', 'C', ['3 onions'])]);
  assert.equal(onionOnly[0].id, aggregateRecipes(recipes).find((item) => item.normalizedIngredient === 'onion')?.id, 'the id depends on the ingredient and unit, not on the recipes');
}

{
  // Audit 13: the seed meal plan follows the current week. seed.ts uses extensionless imports, which Node cannot
  // resolve, so it is loaded through a temporary copy whose imports point at the .ts files.
  const seedSource = readFileSync(new URL('../lib/seed.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(seedSource, /date: '\d{4}-\d{2}-\d{2}'/, 'no pinned meal plan dates');
  const rewired = seedSource
    .replace("from './domain'", `from '${new URL('../lib/domain.ts', import.meta.url).href}'`)
    .replace("from './types'", `from '${new URL('../lib/types.ts', import.meta.url).href}'`);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'savor-seed-'));
  const tempFile = path.join(tempDir, 'seed.mts');
  writeFileSync(tempFile, rewired);
  let seed: typeof import('../lib/seed.ts');
  try {
    seed = await import(pathToFileURL(tempFile).href) as typeof import('../lib/seed.ts');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const weekStart = new Date();
  weekStart.setHours(12, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const key = (offset: number): string => {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  assert.deepEqual(seed.SEED_MEAL_PLAN.map((entry) => entry.date), [key(0), key(2), key(3), key(4)], 'Sunday, Tuesday, Wednesday, Thursday of this week');
  assert.deepEqual(seed.SEED_MEAL_PLAN.map((entry) => entry.id), ['meal_seed_sunday', 'meal_seed_tuesday', 'meal_seed_wednesday', 'meal_seed_thursday'], 'seed ids do not depend on the date');
  assert.deepEqual(seed.SEED_MEAL_PLAN.map((entry) => entry.recipeId), ['recipe_lemon_chicken', 'recipe_tuscan_pasta', 'recipe_salmon_bowl', 'recipe_chicken_tacos']);
  assert(seed.SEED_GROCERY_ITEMS.length > 0);
  assert.deepEqual(seed.SEED_GROCERY_ITEMS.map((item) => item.id), seed.SEED_GROCERY_ITEMS.map((_item, index) => `seed_grocery_${index + 1}`));
  const planned = seed.SEED_RECIPES.filter((item) => seed.SEED_MEAL_PLAN.some((entry) => entry.recipeId === item.id));
  const regenerated = aggregateRecipes(planned, Object.fromEntries(seed.SEED_MEAL_PLAN.map((entry) => [entry.recipeId, entry.servings])), seed.SEED_PREFERENCES.pantryStaples);
  assert.deepEqual(seed.SEED_GROCERY_ITEMS.map((item) => [item.normalizedIngredient, item.unit]), regenerated.map((item) => [item.normalizedIngredient, item.unit]), 'the seed list is the aggregation of the seed plan');
}

{
  // Audit 14: the display helpers the grocery view switches to.
  assert.equal(formatQuantityWithUnit(rational(7), 'clove'), '7 cloves');
  assert.equal(formatQuantityWithUnit(rational(2), 'cup'), '2 cups');
  assert.equal(formatQuantityWithUnit(rational(3, 2), 'lb'), '1½ lb');
  assert.equal(formatQuantityWithUnit(rational(1), 'can'), '1 can');
  assert.equal(formatQuantityWithUnit(rational(2), 'can'), '2 cans');
  assert.equal(formatQuantityWithUnit(rational(1), 'pinch'), '1 pinch');
  assert.equal(formatQuantityWithUnit(rational(2), 'pinch'), '2 pinches');
  assert.equal(pluralizeUnit('clove', 7), 'cloves');
  assert.equal(pluralizeUnit('cup', 2), 'cups');
  assert.equal(pluralizeUnit('pinch', rational(5, 2)), 'pinches');
}

{
  // Audit 15: caption sign-offs end the ingredient block; chatter glued to an ingredient is dropped.
  expectLine('Splash of water to loosen & feel free to add a bit of grated Parmesan!!', { quantity: '1', unit: 'splash', ingredientName: 'water', note: 'to loosen', skipGrocery: true, needsReview: false });
  expectLine('1 tsp chili flakes if you like it spicy', { ingredientName: 'chili flakes', groceryCategory: 'Spices & Seasonings' });
  const caption = [
    'Creamy Chicken Pasta 🍝', 'Ingredients:', '2 chicken breasts', '1 tsp garlic granules', '1 tsp mixed herbs', '½ tsp chili flakes', '200ml cream',
    'Splash of water to loosen & feel free to add a bit of grated Parmesan!!', 'Method is in the caption!🥰🎉',
    'If you like more recipes like this, check on my bio for my recipe app ‘Mollys Happy Healthy Kitchen’🥰🩷',
  ].join('\n');
  const { draft, warnings } = parseRecipeText(caption);
  assert.deepEqual(draft.ingredients.map((item) => item.ingredientName), ['chicken breasts', 'garlic granules', 'mixed herbs', 'chili flakes', 'cream', 'water']);
  assert.deepEqual(draft.ingredients.map((item) => item.groceryCategory), ['Meat & Seafood', 'Spices & Seasonings', 'Spices & Seasonings', 'Spices & Seasonings', 'Dairy & Eggs', 'Other']);
  assert.equal(draft.ingredients.at(-1)?.skipGrocery, true);
  assert.equal(draft.ingredients.at(-1)?.note, 'to loosen');
  assert.equal(draft.ingredients.some((item) => item.needsReview), false);
  assert.deepEqual(warnings, ['No instruction steps were confidently detected.']);
  const groceries = aggregateRecipes([draftToRecipe(draft)]);
  assert.equal(groceries.some((item) => item.groceryCategory === 'Other'), false, 'no sign-off reaches the list');
  assert.equal(groceries.some((item) => item.normalizedIngredient === 'water'), false);
  const resumed = parseRecipeText(`${caption}\n1. Fry the chicken.\n2. Stir in the cream.\nEnjoy!`);
  assert.deepEqual(resumed.draft.instructions.map((step) => step.text), ['Fry the chicken.', 'Stir in the cream.', 'Enjoy!'], 'numbered steps resume the parse after a sign-off');
  assert.equal(resumed.draft.ingredients.length, 6);
  const headed = parseRecipeText(`${caption}\nMethod\nFry the chicken.`);
  assert.deepEqual(headed.draft.instructions.map((step) => step.text), ['Fry the chicken.'], 'an instructions heading resumes the parse');
  for (const line of ['Follow for more easy dinners!', 'Enjoy!', 'Save this for later', 'Get the full recipe from my app!', 'Tag a friend who needs this.', 'Honestly this is the easiest dinner you will make all week.']) {
    const parsed = parseRecipeText(`Dish\nIngredients\n1 cup rice\n${line}\n2 tbsp soy sauce`);
    assert.deepEqual(parsed.draft.ingredients.map((item) => item.ingredientName), ['rice'], `"${line}" ends the ingredient block`);
  }
  const kept = parseRecipeText('Dish\nIngredients\n1 cup rice\nParmesan to serve (I like a lot!)\nFresh herbs to garnish, I used parsley!\nMethod\nCook.');
  assert.deepEqual(kept.draft.ingredients.map((item) => item.ingredientName), ['rice', 'Parmesan', 'Fresh herbs'], 'lines that name something to buy stay');
}

{
  // Audit 16: dried, ground and granulated produce words are spice-rack items.
  const spices = [
    'garlic granules', 'garlic powder', 'onion powder', 'onion granules', 'mixed herbs', 'italian herbs', 'dried mixed herbs', 'herbes de provence',
    'chili flakes', 'chilli flakes', 'red pepper flakes', 'dried oregano', 'dried basil', 'dried thyme', 'dried parsley', 'dried dill', 'dried rosemary',
    'bouillon', 'stock cube', 'chicken stock cube', 'curry powder', 'five spice', "za'atar", 'sumac', 'smoked paprika', 'cayenne', 'ground ginger',
    'ground cumin', 'ground coriander', 'ground cinnamon', 'garam masala', 'everything bagel seasoning', 'ginger powder', 'dried chives',
  ];
  const misses = spices.filter((name) => groceryCategoryFor(normalizeIngredientName(name)) !== 'Spices & Seasonings')
    .map((name) => `${name}: ${groceryCategoryFor(normalizeIngredientName(name))}`);
  assert.deepEqual(misses, []);
  assert.equal(groceryCategoryFor(normalizeIngredientName('mixed seeds')), 'Pantry');
  for (const [name, category] of [['fresh herbs', 'Produce'], ['herbs', 'Produce'], ['garlic', 'Produce'], ['ginger', 'Produce'], ['crushed garlic', 'Produce'], ['dried cranberries', 'Pantry'], ['dried mushrooms', 'Pantry'], ['frozen chopped onion', 'Frozen']] as const) {
    assert.equal(groceryCategoryFor(normalizeIngredientName(name)), category, name);
  }
  expectLine('1 tsp garlic granules', { groceryCategory: 'Spices & Seasonings' });
  expectLine('1 tsp mixed herbs', { groceryCategory: 'Spices & Seasonings' });
}

{
  // A fresh bunch of herbs is produce even when it is described as a blend; only the dried blend is a seasoning.
  expectLine('1 handful fresh mixed herbs', { groceryCategory: 'Produce' });
  expectLine('1 tbsp fresh italian herbs, chopped', { groceryCategory: 'Produce' });
  expectLine('1 tsp dried mixed herbs', { groceryCategory: 'Spices & Seasonings' });
  // Deterministic grocery ids never lose their hash to the collision suffix.
  const twice = aggregateRecipes([
    draftToRecipe({ ...createBlankDraft('manual'), id: 'id_a', title: 'A', ingredients: [parseIngredientLine('2 lemons')] }),
    draftToRecipe({ ...createBlankDraft('manual'), id: 'id_b', title: 'B', ingredients: [parseIngredientLine('1 lemon')] }),
  ]);
  assert.equal(twice.length, 1);
  assert.match(twice[0].id, /^grocery_[0-9a-f]{8}$/);
  // Grammar of the review warning.
  assert.deepEqual(parseRecipeText('Soup\nIngredients\nSpray oil or 1 tbsp olive oil\n1 cup stock\nMethod\n1. Simmer.').warnings, ['1 ingredient needs a quick review.']);
}

{
  // Grocery list merging: refreshing from the plan and adding from a recipe must never duplicate ids,
  // must keep purchases only while the same recipe is still planned, and must resurface a checked row
  // that a new recipe needs again.
  const tacos = draftToRecipe({ ...createBlankDraft('manual'), id: 'tacos', title: 'Tacos', servings: 4, ingredients: ['2 limes', '8 corn tortillas'].map((line) => parseIngredientLine(line)) }, '2026-10-01T12:00:00.000Z');
  const salad = draftToRecipe({ ...createBlankDraft('manual'), id: 'salad', title: 'Salad', servings: 4, ingredients: ['1 lime', '2 avocados'].map((line) => parseIngredientLine(line)) }, '2026-10-01T12:00:00.000Z');
  const soup = draftToRecipe({ ...createBlankDraft('manual'), id: 'soup', title: 'Soup', servings: 4, ingredients: ['3 limes', '1 onion'].map((line) => parseIngredientLine(line)) }, '2026-10-01T12:00:00.000Z');

  const week1 = replaceGeneratedItems([], aggregateRecipes([tacos]), '2026-10-02T12:00:00.000Z');
  const limes = week1.find((row) => row.normalizedIngredient === 'lime');
  assert(limes, 'limes are listed');
  const bought = week1.map((row) => row.normalizedIngredient === 'lime' ? { ...row, checked: true, purchasedAt: '2026-10-03T12:00:00.000Z' } : row);

  // Same plan refreshed: the checked limes stay checked and keep their id.
  const refreshed = replaceGeneratedItems(bought, aggregateRecipes([tacos]), '2026-10-04T12:00:00.000Z');
  assert.equal(refreshed.find((row) => row.normalizedIngredient === 'lime')?.id, limes.id);
  assert.equal(refreshed.find((row) => row.normalizedIngredient === 'lime')?.checked, true);

  // A new week with a different recipe needing limes: the old purchase does not pre-check it, and
  // last week's other rows are gone.
  const week2 = replaceGeneratedItems(bought, aggregateRecipes([soup]), '2026-10-08T12:00:00.000Z');
  assert.equal(week2.find((row) => row.normalizedIngredient === 'lime')?.checked, false);
  assert.equal(week2.find((row) => /tortilla/.test(row.normalizedIngredient)), undefined, 'tortillas from the old plan are gone');
  assert.equal(new Set(week2.map((row) => row.id)).size, week2.length, 'ids are unique');

  // Adding a recipe on top merges into existing rows, unchecks a checked row it needs, pins the rows,
  // and keeps unique ids.
  const added = mergeGroceryItems(bought, aggregateRecipes([salad]), '2026-10-05T12:00:00.000Z', { pin: true });
  const mergedLimes = added.find((row) => row.normalizedIngredient === 'lime');
  assert.equal(mergedLimes?.id, limes.id);
  assert.equal(mergedLimes?.checked, false, 'a new need brings the row back out of the cart');
  assert.equal(mergedLimes?.pinned, true);
  assert.equal(formatRational(mergedLimes?.quantity ?? null), '3');
  assert.equal(mergedLimes?.recipeContributions.length, 2);
  assert.equal(new Set(added.map((row) => row.id)).size, added.length, 'ids are unique after a merge');
  // Merging the same recipe twice does not double its contribution.
  const twice = mergeGroceryItems(added, aggregateRecipes([salad]), '2026-10-05T12:00:00.000Z', { pin: true });
  assert.equal(formatRational(twice.find((row) => row.normalizedIngredient === 'lime')?.quantity ?? null), '3');

  // Pinned rows survive a plan refresh; the plan rows are rebuilt around them.
  const refreshedWithExtra = replaceGeneratedItems(added, aggregateRecipes([tacos]), '2026-10-06T12:00:00.000Z');
  assert(refreshedWithExtra.some((row) => row.normalizedIngredient === 'avocado'), 'salad avocados stay');
  assert(refreshedWithExtra.some((row) => /tortilla/.test(row.normalizedIngredient)), 'plan rows are rebuilt');
  assert.equal(new Set(refreshedWithExtra.map((row) => row.id)).size, refreshedWithExtra.length, 'ids stay unique');
}

console.log('Domain tests passed: 66 scenarios');

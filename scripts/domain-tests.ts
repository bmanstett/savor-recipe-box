import assert from 'node:assert/strict';
import { aggregateRecipes, createBlankDraft, draftToRecipe, formatRational, parseIngredientLine, parseRecipeText } from '../lib/domain.ts';
import { buildSundayPrepRecommendation, optimizeMealWeek } from '../lib/meal-week-optimizer.ts';
import { formatSkylightWeek, isValidSkylightDeviceEmail, normalizeSkylightEmailApp, skylightEmailDraftUrl, skylightGmailComposeUrl, skylightMailto } from '../lib/skylight.ts';
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

console.log('Domain tests passed: 22 scenarios');

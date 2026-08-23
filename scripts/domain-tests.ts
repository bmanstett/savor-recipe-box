import assert from 'node:assert/strict';
import { aggregateRecipes, createBlankDraft, draftToRecipe, formatRational, parseIngredientLine } from '../lib/domain.ts';
import { formatSkylightWeek, isValidSkylightDeviceEmail, skylightMailto } from '../lib/skylight.ts';
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
  assert.match(skylightMailto('FAMILY@ourskylight.com', draft), /^mailto:family@ourskylight\.com\?/);
}

console.log('Domain tests passed: 11 scenarios');

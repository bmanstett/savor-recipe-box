import { aggregateRecipes, parseIngredientLine } from './domain';
import type { GroceryItem, HouseholdPreferences, Instruction, MealPlanEntry, Recipe } from './types';

function ingredients(recipeId: string, lines: string[], section: string | null = null) {
  return lines.map((line, index) => ({ ...parseIngredientLine(line, section), id: `${recipeId}_ing_${index + 1}` }));
}

function steps(recipeId: string, lines: string[]): Instruction[] {
  return lines.map((text, index) => ({
    id: `${recipeId}_step_${index + 1}`,
    stepNumber: index + 1,
    section: null,
    text,
    timerMinutes: Number(text.match(/\b(\d+)\s+minutes?\b/i)?.[1] ?? '') || null,
  }));
}

const added = '2026-08-20T18:00:00.000Z';

export const SEED_RECIPES: Recipe[] = [
  {
    id: 'recipe_lemon_chicken',
    title: 'Lemon herb roast chicken',
    description: 'Golden, crisp, and bright with rosemary, garlic, and citrus.',
    heroImage: './recipes/lemon-chicken.jpg',
    sourceType: 'manual', sourceURL: null, sourceName: 'Our kitchen', author: null,
    servings: 4, prepTime: 15, cookTime: 55, totalTime: 70,
    cuisine: 'Mediterranean', categories: ['Dinner'], tags: ['Family favorite', 'Sunday dinner'],
    ingredients: ingredients('recipe_lemon_chicken', [
      '1 whole chicken', '1 1/2 lb baby potatoes', '2 lemons', '4 cloves garlic',
      '2 tbsp olive oil', '1 tbsp fresh rosemary, chopped', '2 tsp kosher salt', '1/2 tsp black pepper',
    ]),
    instructions: steps('recipe_lemon_chicken', [
      'Heat the oven to 425°F. Pat the chicken dry and place it in a roasting pan with the potatoes.',
      'Zest one lemon. Mix the zest with garlic, olive oil, rosemary, salt, and pepper, then rub it over the chicken.',
      'Quarter both lemons and tuck them around the chicken. Roast for 50 to 55 minutes, until deeply golden and cooked through.',
      'Rest for 10 minutes before carving. Spoon the bright pan juices over the chicken and potatoes.',
    ]),
    rating: 5, favorite: true, notes: 'Add extra lemon wedges for the table.', attachments: [],
    dateAdded: '2026-07-12T14:00:00.000Z', dateModified: added,
    lastCooked: '2026-07-26T23:10:00.000Z', timesCooked: 4, revision: 1, deletedAt: null,
  },
  {
    id: 'recipe_tuscan_pasta',
    title: 'Creamy Tuscan pasta',
    description: 'Silky sun-dried tomato sauce, spinach, and parmesan in one pan.',
    heroImage: './recipes/tuscan-pasta.jpg',
    sourceType: 'url', sourceURL: null, sourceName: 'Saved from the web', author: null,
    servings: 4, prepTime: 10, cookTime: 15, totalTime: 25,
    cuisine: 'Italian', categories: ['Dinner'], tags: ['Weeknight', 'Under 30 minutes', 'Pasta'],
    ingredients: ingredients('recipe_tuscan_pasta', [
      '12 oz rigatoni pasta', '1 tbsp olive oil', '3 cloves garlic, minced', '1/2 cup sun-dried tomatoes, chopped',
      '1 cup heavy cream', '1/2 cup grated parmesan', '3 cups baby spinach', '1/2 tsp red pepper flakes',
    ]),
    instructions: steps('recipe_tuscan_pasta', [
      'Boil the pasta in well-salted water until just shy of al dente. Reserve 1 cup pasta water.',
      'Warm the olive oil in a wide skillet. Add garlic, sun-dried tomatoes, and pepper flakes; cook for 1 minute.',
      'Stir in the cream and parmesan. Add the pasta and enough pasta water to make the sauce glossy.',
      'Fold in the spinach until wilted, then season and serve with more parmesan.',
    ]),
    rating: 4, favorite: true, notes: '', attachments: [], dateAdded: added, dateModified: added,
    lastCooked: null, timesCooked: 1, revision: 1, deletedAt: null,
  },
  {
    id: 'recipe_salmon_bowl',
    title: 'Ginger salmon bowls',
    description: 'Caramelized salmon, crunchy vegetables, and sesame rice.',
    heroImage: './recipes/salmon-bowl.jpg',
    sourceType: 'manual', sourceURL: null, sourceName: 'Our kitchen', author: null,
    servings: 4, prepTime: 20, cookTime: 15, totalTime: 35,
    cuisine: 'Asian-inspired', categories: ['Dinner', 'Lunch'], tags: ['Healthy', 'Bowls'],
    ingredients: ingredients('recipe_salmon_bowl', [
      '1 1/2 lb salmon', '2 cups jasmine rice', '2 tbsp soy sauce', '1 tbsp honey', '1 tbsp fresh ginger, grated',
      '1 cucumber, sliced', '2 carrots, shredded', '1 avocado, sliced', '2 tsp sesame oil',
    ]),
    instructions: steps('recipe_salmon_bowl', [
      'Cook the rice according to the package directions and keep warm.',
      'Whisk soy sauce, honey, ginger, and sesame oil. Brush over the salmon.',
      'Roast the salmon at 425°F for 10 to 12 minutes, until it flakes easily.',
      'Divide rice among bowls and add salmon, cucumber, carrots, and avocado. Spoon over any remaining sauce.',
    ]),
    rating: 5, favorite: false, notes: '', attachments: [], dateAdded: '2026-08-18T16:20:00.000Z', dateModified: added,
    lastCooked: null, timesCooked: 0, revision: 1, deletedAt: null,
  },
  {
    id: 'recipe_chicken_tacos',
    title: 'Smoky chicken tacos',
    description: 'Charred chicken, lime crema, and crisp cabbage for taco night.',
    heroImage: './recipes/chicken-tacos.jpg',
    sourceType: 'pasted-text', sourceURL: null, sourceName: 'Family notes', author: null,
    servings: 4, prepTime: 15, cookTime: 15, totalTime: 30,
    cuisine: 'Mexican-inspired', categories: ['Dinner'], tags: ['Weeknight', 'Tacos'],
    ingredients: ingredients('recipe_chicken_tacos', [
      '1 1/2 lb chicken breasts', '2 tsp smoked paprika', '1 tsp cumin', '1 tbsp olive oil',
      '8 corn tortillas', '2 cups shredded cabbage', '1/2 cup sour cream', '2 limes',
    ]),
    instructions: steps('recipe_chicken_tacos', [
      'Season the chicken with paprika, cumin, salt, and olive oil.',
      'Cook in a hot skillet for 5 to 6 minutes per side. Rest, then slice.',
      'Stir sour cream with the juice of one lime. Warm the tortillas.',
      'Fill tortillas with cabbage and chicken, then finish with lime crema.',
    ]),
    rating: 4, favorite: false, notes: '', attachments: [], dateAdded: '2026-08-16T20:10:00.000Z', dateModified: added,
    lastCooked: null, timesCooked: 2, revision: 1, deletedAt: null,
  },
  {
    id: 'recipe_tomato_soup',
    title: 'Roasted tomato soup',
    description: 'A velvety pantry-friendly soup with slow-roasted tomatoes and garlic.',
    heroImage: './recipes/tomato-soup.jpg',
    sourceType: 'url', sourceURL: null, sourceName: 'Saved from the web', author: null,
    servings: 6, prepTime: 10, cookTime: 35, totalTime: 45,
    cuisine: 'American', categories: ['Lunch', 'Dinner'], tags: ['Freezer friendly', 'Vegetarian'],
    ingredients: ingredients('recipe_tomato_soup', [
      '3 lb roma tomatoes', '1 yellow onion', '6 cloves garlic', '2 tbsp olive oil', '3 cups vegetable broth', '1/2 cup heavy cream',
    ]),
    instructions: steps('recipe_tomato_soup', [
      'Roast tomatoes, onion, and garlic with olive oil at 425°F until caramelized, about 30 minutes.',
      'Transfer to a pot with broth and simmer for 10 minutes.',
      'Blend until silky, stir in cream, and season to taste.',
    ]),
    rating: 5, favorite: true, notes: '', attachments: [], dateAdded: '2026-08-21T13:45:00.000Z', dateModified: added,
    lastCooked: null, timesCooked: 1, revision: 1, deletedAt: null,
  },
  {
    id: 'recipe_bean_salad',
    title: 'Herby white bean salad',
    description: 'Creamy beans, crunchy cucumber, and a lemony herb dressing.',
    heroImage: './recipes/bean-salad.jpg',
    sourceType: 'manual', sourceURL: null, sourceName: 'Our kitchen', author: null,
    servings: 4, prepTime: 20, cookTime: 0, totalTime: 20,
    cuisine: 'Mediterranean', categories: ['Lunch', 'Side'], tags: ['No cook', 'Vegetarian'],
    ingredients: ingredients('recipe_bean_salad', [
      '2 cans cannellini beans, drained', '1 cucumber, diced', '1 cup cherry tomatoes', '1/2 red onion, sliced',
      '1 lemon', '2 tbsp olive oil', '1/2 cup parsley, chopped',
    ]),
    instructions: steps('recipe_bean_salad', [
      'Whisk lemon juice and olive oil with salt and pepper.',
      'Combine beans, cucumber, tomatoes, onion, and parsley.',
      'Toss with the dressing and let stand for 10 minutes before serving.',
    ]),
    rating: 4, favorite: false, notes: '', attachments: [], dateAdded: '2026-08-22T15:15:00.000Z', dateModified: added,
    lastCooked: null, timesCooked: 0, revision: 1, deletedAt: null,
  },
  {
    id: 'recipe_banana_bread',
    title: 'Sunday banana bread',
    description: 'Tender, deeply banana-scented, and just sweet enough.',
    heroImage: './recipes/banana-bread.jpg',
    sourceType: 'photo', sourceURL: null, sourceName: 'Grandma’s recipe card', author: 'Family recipe',
    servings: 10, prepTime: 15, cookTime: 55, totalTime: 70,
    cuisine: 'American', categories: ['Breakfast', 'Baking'], tags: ['Family recipe', 'Baking'],
    ingredients: ingredients('recipe_banana_bread', [
      '3 ripe bananas', '1/2 cup unsalted butter, melted', '3/4 cup brown sugar', '2 eggs',
      '1 1/2 cups all-purpose flour', '1 tsp baking soda', '1/2 tsp cinnamon',
    ]),
    instructions: steps('recipe_banana_bread', [
      'Heat the oven to 350°F and line a loaf pan with parchment.',
      'Mash the bananas, then whisk in melted butter, sugar, and eggs.',
      'Fold in flour, baking soda, cinnamon, and a pinch of salt just until combined.',
      'Bake for 50 to 55 minutes. Cool in the pan for 10 minutes before lifting out.',
    ]),
    rating: 5, favorite: true, notes: 'The original family card is attached.', attachments: [],
    dateAdded: '2026-08-22T18:30:00.000Z', dateModified: added,
    lastCooked: '2026-08-09T14:30:00.000Z', timesCooked: 7, revision: 1, deletedAt: null,
  },
];

export const SEED_MEAL_PLAN: MealPlanEntry[] = [
  { id: 'meal_2026_08_23', date: '2026-08-23', mealType: 'dinner', recipeId: 'recipe_lemon_chicken', servings: 4, revision: 1, dateModified: added },
  { id: 'meal_2026_08_25', date: '2026-08-25', mealType: 'dinner', recipeId: 'recipe_tuscan_pasta', servings: 4, revision: 1, dateModified: added },
  { id: 'meal_2026_08_26', date: '2026-08-26', mealType: 'dinner', recipeId: 'recipe_salmon_bowl', servings: 4, revision: 1, dateModified: added },
  { id: 'meal_2026_08_27', date: '2026-08-27', mealType: 'dinner', recipeId: 'recipe_chicken_tacos', servings: 4, revision: 1, dateModified: added },
];

export const SEED_PREFERENCES: HouseholdPreferences = {
  pantryStaples: ['kosher salt', 'black pepper', 'olive oil'],
  excludePantryStaples: true,
  sectionOrder: [
    'Produce', 'Bakery', 'Meat & Seafood', 'Dairy & Eggs', 'Pasta, Rice & Grains',
    'Canned & Jarred', 'Pantry', 'Spices & Seasonings', 'Sauces & Condiments', 'Frozen', 'Other',
  ],
};

const plannedRecipes = SEED_MEAL_PLAN.map((entry) => SEED_RECIPES.find((recipe) => recipe.id === entry.recipeId)).filter((recipe): recipe is Recipe => Boolean(recipe));
const servings = Object.fromEntries(SEED_MEAL_PLAN.map((entry) => [entry.recipeId, entry.servings]));

export const SEED_GROCERY_ITEMS: GroceryItem[] = aggregateRecipes(
  plannedRecipes,
  servings,
  SEED_PREFERENCES.excludePantryStaples ? SEED_PREFERENCES.pantryStaples : [],
).map((item, index) => ({ ...item, id: `seed_grocery_${index + 1}` }));

import type { GroceryItem, Ingredient, MealPlanEntry, MealType, Recipe } from './types';

const DAY_MS = 86_400_000;

export type RecommendationConfidenceLevel = 'high' | 'medium' | 'low';

export interface RecommendationConfidence {
  level: RecommendationConfidenceLevel;
  score: number;
}

export type FreshnessClass =
  | 'seafood'
  | 'leafy-greens'
  | 'raw-meat'
  | 'delicate-produce'
  | 'dairy-eggs'
  | 'bakery'
  | 'sturdy-produce'
  | 'other'
  | 'pantry'
  | 'frozen';

export interface FreshnessAssessment {
  category: FreshnessClass;
  limitingIngredients: string[];
  earliestUseBy: string | null;
  purchaseCoverage: number;
  status: 'within-window' | 'partially-known' | 'heuristic-only' | 'verify-before-use';
}

export interface RecommendedMeal {
  slotId: string;
  sourceEntryId: string;
  date: string;
  originalDate: string;
  mealType: MealType;
  recipeId: string;
  recipeTitle: string;
  servings: number | null;
  ingredientUseDate: string;
  moved: boolean;
  freshness: FreshnessAssessment;
  reasons: string[];
  confidence: RecommendationConfidence;
}

export type SundayPrepTaskKind =
  | 'marinate'
  | 'chop-sturdy-produce'
  | 'make-sauce'
  | 'cook-grain-or-bean'
  | 'portion-lunch';

export interface SundayPrepTask {
  id: string;
  kind: SundayPrepTaskKind;
  recipeId: string;
  recipeTitle: string;
  mealDates: string[];
  instruction: string;
  reasons: string[];
  confidence: RecommendationConfidence;
}

export type SundayPrepWarningKind =
  | 'seafood'
  | 'delicate-greens'
  | 'raw-meat'
  | 'cut-potatoes'
  | 'refrigerated-lunch';

export interface SundayPrepWarning {
  id: string;
  kind: SundayPrepWarningKind;
  recipeId: string;
  recipeTitle: string;
  mealDates: string[];
  message: string;
  recommendation: string;
}

export interface SundayPrepPlan {
  date: string;
  tasks: SundayPrepTask[];
  warnings: SundayPrepWarning[];
  confidence: RecommendationConfidence;
}

export interface RecommendationDataQuality {
  purchaseCoverage: number;
  matchedIngredients: number;
  totalIngredients: number;
  confidence: RecommendationConfidence;
  reasons: string[];
}

export interface UnresolvedMealEntry {
  sourceEntryId: string;
  recipeId: string;
  originalDate: string;
  reason: 'invalid-date' | 'missing-recipe';
}

export interface MealWeekOptimizerInput {
  recipes: readonly Recipe[];
  mealPlan: readonly MealPlanEntry[];
  groceryItems: readonly GroceryItem[];
  week: {
    startDate: string;
    endDate: string;
  };
}

export interface MealWeekRecommendation {
  week: {
    startDate: string;
    endDate: string;
    sundayPrepDate: string;
  };
  schedule: RecommendedMeal[];
  sundayPrep: SundayPrepPlan;
  unresolvedEntries: UnresolvedMealEntry[];
  dataQuality: RecommendationDataQuality;
}

interface FreshnessRule {
  category: FreshnessClass;
  rank: number;
  conservativeDays: number;
}

interface IngredientProfile extends FreshnessRule {
  ingredient: Ingredient;
  purchaseDay: number | null;
  useByDay: number | null;
}

interface RecipeProfile {
  recipe: Recipe;
  ingredients: IngredientProfile[];
  category: FreshnessClass;
  rank: number;
  limitingIngredients: string[];
  earliestUseByDay: number | null;
  matchedIngredients: number;
  totalIngredients: number;
}

interface Candidate {
  source: MealPlanEntry;
  profile: RecipeProfile;
}

const MEAL_TYPE_ORDER: Record<MealType, number> = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };

const CLASS_LABELS: Record<FreshnessClass, string> = {
  seafood: 'seafood',
  'leafy-greens': 'leafy greens',
  'raw-meat': 'raw meat',
  'delicate-produce': 'delicate produce',
  'dairy-eggs': 'dairy or eggs',
  bakery: 'bakery items',
  'sturdy-produce': 'sturdy produce',
  other: 'moderately perishable ingredients',
  pantry: 'pantry ingredients',
  frozen: 'frozen ingredients',
};

const STURDY_PRODUCE = /\b(carrot|cabbage|celery|onion|shallot|bell pepper|broccoli|cauliflower|radish|turnip|beet|parsnip|squash)\b/i;
const DELICATE_GREENS = /\b(spinach|lettuce|arugula|rocket|kale|chard|collard|bok choy|watercress|spring mix|mixed greens)\b/i;
const FRESH_HERBS = /\b(basil|parsley|cilantro|dill|mint|chive|tarragon)\b/i;
const DELICATE_PRODUCE = /\b(avocado|cucumber|berry|berries|peach|pear|tomato|mushroom|asparagus|zucchini)\b/i;
const SEAFOOD = /\b(salmon|shrimp|prawn|fish|cod|tilapia|tuna|trout|halibut|scallop|crab|lobster|mussel|oyster|clam)\b/i;
const RAW_MEAT = /\b(chicken|turkey|beef|pork|lamb|steak|sausage|ground meat|duck)\b/i;
const SHELF_STABLE = /\b(canned|tinned|shelf-stable|broth|stock|jerky)\b/i;
const PRECOOKED_PROTEIN = /\b(cooked|rotisserie|smoked|deli|leftover|fully cooked)\b/i;
const DAIRY_EGGS = /\b(milk|cream|butter|cheese|mozzarella|parmesan|yogurt|egg|sour cream|crema)\b/i;
const BAKERY = /\b(bread|roll|tortilla|baguette|bun|pita|naan)\b/i;
const POTATO = /\bpotato(?:es)?\b/i;
const GRAIN_OR_BEAN = /\b(rice|quinoa|couscous|farro|barley|bulgur|lentil|bean|chickpea)\b/i;

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function roundRatio(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 100) / 100 : 0;
}

function confidenceFromScore(value: number): RecommendationConfidence {
  const normalized = Math.max(0, Math.min(1, value));
  return {
    level: normalized >= 0.8 ? 'high' : normalized >= 0.55 ? 'medium' : 'low',
    score: Math.round(normalized * 100),
  };
}

function parseDateKey(value: string): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new RangeError(`Invalid date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new RangeError(`Invalid date: ${value}`);
  }
  return Math.floor(timestamp / DAY_MS);
}

function tryParseDateKey(value: string): number | null {
  try {
    return parseDateKey(value);
  } catch {
    return null;
  }
}

function purchaseDay(value: string | null | undefined): number | null {
  if (!value) return null;
  return tryParseDateKey(value.slice(0, 10));
}

function dateKeyFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function sundayOnOrBefore(day: number): number {
  return day - new Date(day * DAY_MS).getUTCDay();
}

function ingredientText(ingredient: Ingredient): string {
  return `${ingredient.normalizedIngredient} ${ingredient.ingredientName} ${ingredient.rawText}`.toLowerCase();
}

function classifyIngredient(ingredient: Ingredient): FreshnessRule {
  const text = ingredientText(ingredient);
  if (ingredient.groceryCategory === 'Frozen' || /\bfrozen\b/i.test(text)) {
    return { category: 'frozen', rank: 9, conservativeDays: 60 };
  }
  if (ingredient.normalizedUnit === 'can' || SHELF_STABLE.test(text) || ingredient.groceryCategory === 'Canned & Jarred') {
    return { category: 'pantry', rank: 8, conservativeDays: 30 };
  }
  if (SEAFOOD.test(text)) return { category: 'seafood', rank: 0, conservativeDays: 1 };
  if (DELICATE_GREENS.test(text) || FRESH_HERBS.test(text)) {
    return { category: 'leafy-greens', rank: 1, conservativeDays: 2 };
  }
  if (RAW_MEAT.test(text)) {
    return PRECOOKED_PROTEIN.test(text)
      ? { category: 'other', rank: 3, conservativeDays: 3 }
      : { category: 'raw-meat', rank: 2, conservativeDays: 2 };
  }
  if (DELICATE_PRODUCE.test(text)) return { category: 'delicate-produce', rank: 3, conservativeDays: 4 };
  if (DAIRY_EGGS.test(text) || ingredient.groceryCategory === 'Dairy & Eggs') {
    return { category: 'dairy-eggs', rank: 4, conservativeDays: 5 };
  }
  if (BAKERY.test(text) || ingredient.groceryCategory === 'Bakery') {
    return { category: 'bakery', rank: 5, conservativeDays: 4 };
  }
  if (STURDY_PRODUCE.test(text) || POTATO.test(text)) {
    return { category: 'sturdy-produce', rank: 6, conservativeDays: 7 };
  }
  if (
    ingredient.groceryCategory === 'Pantry'
    || ingredient.groceryCategory === 'Pasta, Rice & Grains'
    || ingredient.groceryCategory === 'Spices & Seasonings'
    || ingredient.groceryCategory === 'Sauces & Condiments'
  ) {
    return { category: 'pantry', rank: 8, conservativeDays: 30 };
  }
  return { category: 'other', rank: 7, conservativeDays: 7 };
}

function matchingPurchaseDay(
  recipeId: string,
  ingredient: Ingredient,
  groceryItems: readonly GroceryItem[],
): number | null {
  const exact = groceryItems.filter((item) => item.recipeContributions.some((contribution) => (
    contribution.recipeId === recipeId && contribution.ingredientId === ingredient.id
  )));
  const fallback = groceryItems.filter((item) => item.normalizedIngredient === ingredient.normalizedIngredient);
  const exactDays = exact
    .map((item) => purchaseDay(item.purchasedAt))
    .filter((day): day is number => day !== null)
    .sort((first, second) => first - second);
  if (exactDays.length) return exactDays[0];
  const fallbackDays = fallback
    .map((item) => purchaseDay(item.purchasedAt))
    .filter((day): day is number => day !== null)
    .sort((first, second) => first - second);
  return fallbackDays[0] ?? null;
}

function buildRecipeProfile(
  recipe: Recipe,
  groceryItems: readonly GroceryItem[],
): RecipeProfile {
  const ingredients = recipe.ingredients.map((ingredient): IngredientProfile => {
    const rule = classifyIngredient(ingredient);
    const bought = matchingPurchaseDay(recipe.id, ingredient, groceryItems);
    return {
      ...rule,
      ingredient,
      purchaseDay: bought,
      useByDay: bought === null ? null : bought + rule.conservativeDays,
    };
  });
  const rank = ingredients.reduce((lowest, ingredient) => Math.min(lowest, ingredient.rank), 7);
  const category = ingredients.find((ingredient) => ingredient.rank === rank)?.category ?? 'other';
  const limitingIngredients = [...new Set(ingredients
    .filter((ingredient) => ingredient.rank === rank)
    .map((ingredient) => ingredient.ingredient.ingredientName))].sort(compareText);
  const knownUseBy = ingredients
    .map((ingredient) => ingredient.useByDay)
    .filter((day): day is number => day !== null)
    .sort((first, second) => first - second);
  const matchedIngredients = ingredients.filter((ingredient) => ingredient.purchaseDay !== null).length;
  return {
    recipe,
    ingredients,
    category,
    rank,
    limitingIngredients,
    earliestUseByDay: knownUseBy[0] ?? null,
    matchedIngredients,
    totalIngredients: ingredients.length,
  };
}

function compareCandidates(first: Candidate, second: Candidate): number {
  if (first.profile.rank !== second.profile.rank) return first.profile.rank - second.profile.rank;
  const firstExpiry = first.profile.earliestUseByDay ?? Number.POSITIVE_INFINITY;
  const secondExpiry = second.profile.earliestUseByDay ?? Number.POSITIVE_INFINITY;
  if (firstExpiry !== secondExpiry) return firstExpiry - secondExpiry;
  return compareText(first.source.date, second.source.date)
    || compareText(first.profile.recipe.id, second.profile.recipe.id)
    || compareText(first.source.id, second.source.id);
}

function mealConfidence(profile: RecipeProfile, useDay: number): RecommendationConfidence {
  if (!profile.totalIngredients) return confidenceFromScore(0.25);
  const coverage = profile.matchedIngredients / profile.totalIngredients;
  let score = coverage === 1 ? 0.9 : coverage > 0 ? 0.66 : 0.42;
  if (profile.ingredients.every((ingredient) => ingredient.category === 'pantry' || ingredient.category === 'frozen')) {
    score += 0.06;
  }
  if (profile.ingredients.some((ingredient) => ingredient.useByDay !== null && ingredient.useByDay < useDay)) score -= 0.2;
  if (profile.ingredients.some((ingredient) => ingredient.purchaseDay !== null && ingredient.purchaseDay > useDay)) score -= 0.2;
  return confidenceFromScore(score);
}

function buildRecommendedMeal(
  slot: MealPlanEntry,
  candidate: Candidate,
  sundayPrepDay: number,
): RecommendedMeal {
  const { source, profile } = candidate;
  const useDay = slot.mealType === 'lunch' ? sundayPrepDay : parseDateKey(slot.date);
  const coverage = roundRatio(profile.matchedIngredients, profile.totalIngredients);
  const expired = profile.ingredients.some((ingredient) => ingredient.useByDay !== null && ingredient.useByDay < useDay);
  const futurePurchase = profile.ingredients.some((ingredient) => ingredient.purchaseDay !== null && ingredient.purchaseDay > useDay);
  const reasons: string[] = [];

  if (profile.limitingIngredients.length) {
    reasons.push(`Prioritized from its ${CLASS_LABELS[profile.category]}: ${profile.limitingIngredients.join(', ')}.`);
  } else {
    reasons.push('This recipe has no structured ingredients, so freshness could not be estimated precisely.');
  }
  if (!profile.matchedIngredients) {
    reasons.push('No matching purchase timestamps were available; placement uses conservative ingredient-category heuristics only.');
  } else if (profile.matchedIngredients < profile.totalIngredients) {
    reasons.push(`Purchase timestamps cover ${profile.matchedIngredients} of ${profile.totalIngredients} ingredients; unmatched ingredients remain heuristic.`);
  } else {
    reasons.push('Purchase timestamps cover every structured ingredient in this recipe.');
  }
  if (slot.mealType === 'lunch') {
    reasons.push(`Lunch ingredients are treated as used on ${dateKeyFromDay(sundayPrepDay)} because lunches are meal-prepped Sunday.`);
    reasons.push('More perishable prepared lunches are placed earlier; later portions may need freezing.');
  }
  if (source.date !== slot.date) {
    reasons.push(`Moved from ${source.date} to ${slot.date} to use more perishable ingredients sooner.`);
  }
  if (expired) reasons.push('At least one recorded purchase is beyond its conservative freshness window; inspect it and replace it if uncertain.');
  if (futurePurchase) reasons.push('A recorded purchase date falls after this ingredient-use date; verify the shopping record.');

  const status: FreshnessAssessment['status'] = expired || futurePurchase
    ? 'verify-before-use'
    : !profile.matchedIngredients
      ? 'heuristic-only'
      : profile.matchedIngredients < profile.totalIngredients
        ? 'partially-known'
        : 'within-window';

  return {
    slotId: slot.id,
    sourceEntryId: source.id,
    date: slot.date,
    originalDate: source.date,
    mealType: slot.mealType,
    recipeId: profile.recipe.id,
    recipeTitle: profile.recipe.title,
    servings: source.servings,
    ingredientUseDate: dateKeyFromDay(useDay),
    moved: source.date !== slot.date,
    freshness: {
      category: profile.category,
      limitingIngredients: profile.limitingIngredients,
      earliestUseBy: profile.earliestUseByDay === null ? null : dateKeyFromDay(profile.earliestUseByDay),
      purchaseCoverage: coverage,
      status,
    },
    reasons,
    confidence: mealConfidence(profile, useDay),
  };
}

function instructionText(recipe: Recipe): string {
  return recipe.instructions.map((instruction) => instruction.text).join(' ');
}

function recipeIngredientNames(recipe: Recipe, pattern: RegExp): string[] {
  return [...new Set(recipe.ingredients
    .filter((ingredient) => pattern.test(ingredientText(ingredient)))
    .map((ingredient) => ingredient.ingredientName))].sort(compareText);
}

function buildSundayPrep(
  schedule: readonly RecommendedMeal[],
  recipes: readonly Recipe[],
  sundayPrepDay: number,
  confidence: RecommendationConfidence,
): SundayPrepPlan {
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const mealsByRecipe = new Map<string, RecommendedMeal[]>();
  for (const meal of schedule) {
    const list = mealsByRecipe.get(meal.recipeId) ?? [];
    list.push(meal);
    mealsByRecipe.set(meal.recipeId, list);
  }

  const tasks: SundayPrepTask[] = [];
  const warnings: SundayPrepWarning[] = [];
  const recipeIds = [...mealsByRecipe.keys()].sort((first, second) => {
    const firstDate = mealsByRecipe.get(first)?.[0]?.date ?? '';
    const secondDate = mealsByRecipe.get(second)?.[0]?.date ?? '';
    return compareText(firstDate, secondDate) || compareText(first, second);
  });

  const addTask = (
    kind: SundayPrepTaskKind,
    recipe: Recipe,
    mealDates: string[],
    instruction: string,
    reasons: string[],
    score: number,
  ) => tasks.push({
    id: `prep:${kind}:${recipe.id}`,
    kind,
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    mealDates,
    instruction,
    reasons,
    confidence: confidenceFromScore(score),
  });

  const addWarning = (
    kind: SundayPrepWarningKind,
    recipe: Recipe,
    mealDates: string[],
    message: string,
    recommendation: string,
  ) => warnings.push({
    id: `warning:${kind}:${recipe.id}`,
    kind,
    recipeId: recipe.id,
    recipeTitle: recipe.title,
    mealDates,
    message,
    recommendation,
  });

  for (const recipeId of recipeIds) {
    const recipe = recipesById.get(recipeId);
    const meals = mealsByRecipe.get(recipeId);
    if (!recipe || !meals?.length) continue;
    const mealDates = [...new Set(meals.map((meal) => meal.date))].sort(compareText);
    const useDays = meals.map((meal) => parseDateKey(meal.ingredientUseDate));
    const earliestUseOffset = Math.min(...useDays.map((day) => day - sundayPrepDay));
    const latestUseOffset = Math.max(...useDays.map((day) => day - sundayPrepDay));
    const latestMealOffset = Math.max(...meals.map((meal) => parseDateKey(meal.date) - sundayPrepDay));
    const instructions = instructionText(recipe);
    const seafood = recipe.ingredients
      .filter((ingredient) => classifyIngredient(ingredient).category === 'seafood')
      .map((ingredient) => ingredient.ingredientName)
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort(compareText);
    const rawMeat = recipe.ingredients
      .filter((ingredient) => classifyIngredient(ingredient).category === 'raw-meat')
      .map((ingredient) => ingredient.ingredientName)
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort(compareText);
    const delicateGreens = recipeIngredientNames(recipe, new RegExp(`${DELICATE_GREENS.source}|${FRESH_HERBS.source}`, 'i'));
    const sturdyProduce = recipeIngredientNames(recipe, STURDY_PRODUCE).filter((name) => !POTATO.test(name));
    const potatoes = recipeIngredientNames(recipe, POTATO);

    if (seafood.length) {
      addWarning(
        'seafood', recipe, mealDates,
        `${recipe.title} includes ${seafood.join(', ')}, which should not sit raw or marinating from Sunday.`,
        earliestUseOffset === 0
          ? 'Keep it cold and cook it during Sunday prep; freeze later lunch portions promptly.'
          : 'Keep it frozen, thaw it in the refrigerator close to the meal, and prepare it day-of.',
      );
    }
    if (delicateGreens.length) {
      addWarning(
        'delicate-greens', recipe, mealDates,
        `Do not chop or dress ${delicateGreens.join(', ')} during Sunday prep for ${recipe.title}.`,
        'Keep greens dry and whole, then wash, cut, and dress them close to serving.',
      );
    }
    if (rawMeat.length && latestUseOffset > 1) {
      addWarning(
        'raw-meat', recipe, mealDates,
        `${recipe.title} uses ${rawMeat.join(', ')} more than a day after Sunday prep.`,
        'Do not refrigerate it in marinade all week; keep it frozen and thaw safely in the refrigerator near the meal.',
      );
    }
    if (potatoes.length && latestUseOffset > 0) {
      addWarning(
        'cut-potatoes', recipe, mealDates,
        `Cutting ${potatoes.join(', ')} on Sunday is too early for ${recipe.title}.`,
        'Leave potatoes whole and cut them on cooking day; never leave cut potatoes at room temperature.',
      );
    }

    const seasoningInstruction = /\b(marinat|brin|season|rub)\w*\b/i.test(instructions);
    if (seasoningInstruction && rawMeat.length && earliestUseOffset <= 1) {
      addTask(
        'marinate', recipe, mealDates,
        `Marinate or season only the ${rawMeat.join(', ')} portion being cooked by Monday; keep it covered in the refrigerator.`,
        ['The recipe calls for advance seasoning and the recommended use is within one day of Sunday prep.'],
        0.86,
      );
    } else if (seasoningInstruction && seafood.length && earliestUseOffset === 0) {
      addTask(
        'marinate', recipe, mealDates,
        `Mix the seasoning for ${recipe.title}, then marinate ${seafood.join(', ')} only shortly before cooking on Sunday.`,
        ['Seafood is scheduled for cooking during Sunday prep, not for prolonged raw storage.'],
        0.86,
      );
    }

    if (sturdyProduce.length) {
      addTask(
        'chop-sturdy-produce', recipe, mealDates,
        `Wash and chop ${sturdyProduce.join(', ')} for ${recipe.title}; refrigerate it in labeled airtight containers and leave later-week portions whole.`,
        ['These sturdy vegetables tolerate limited advance chopping better than delicate greens or potatoes.'],
        0.78,
      );
    }

    const directSauceInstruction = /\b(whisk|mix|stir|blend|combine|make)\w*\b[^.]{0,100}\b(sauce|dressing|crema|vinaigrette|glaze|pesto|marinade)\b/i.test(instructions)
      || /\b(sauce|dressing|crema|vinaigrette|glaze|pesto|marinade)\b[^.]{0,100}\b(whisk|mix|stir|blend|combine|make)\w*\b/i.test(instructions);
    const sauceLikeIngredients = recipe.ingredients.filter((ingredient) => (
      ingredient.groceryCategory === 'Sauces & Condiments' || ingredient.groceryCategory === 'Spices & Seasonings'
    )).length;
    const mixingInstruction = /\b(whisk|mix|stir|blend|combine)\w*\b/i.test(instructions);
    if (directSauceInstruction || (mixingInstruction && sauceLikeIngredients >= 2)) {
      const hasPerishableFinish = recipe.ingredients.some((ingredient) => (
        DAIRY_EGGS.test(ingredientText(ingredient)) || FRESH_HERBS.test(ingredientText(ingredient)) || /\bavocado\b/i.test(ingredientText(ingredient))
      ));
      addTask(
        'make-sauce', recipe, mealDates,
        hasPerishableFinish
          ? `Mix the shelf-stable sauce base for ${recipe.title}; refrigerate it and add dairy, avocado, or fresh herbs near serving.`
          : `Make the sauce or dressing for ${recipe.title} and refrigerate it in a labeled airtight container.`,
        [directSauceInstruction ? 'A recipe instruction explicitly describes a sauce or dressing.' : 'The recipe combines multiple seasonings or condiments.'],
        directSauceInstruction ? 0.9 : 0.68,
      );
    }

    const grainsOrBeans = [...new Set(recipe.ingredients
      .filter((ingredient) => GRAIN_OR_BEAN.test(ingredientText(ingredient)))
      .filter((ingredient) => ingredient.normalizedUnit !== 'can' && !SHELF_STABLE.test(ingredientText(ingredient)))
      .map((ingredient) => ingredient.ingredientName))].sort(compareText);
    if (grainsOrBeans.length && /\b(cook|boil|simmer)\w*\b/i.test(instructions)) {
      addTask(
        'cook-grain-or-bean', recipe, mealDates,
        latestMealOffset > 3
          ? `Cook ${grainsOrBeans.join(', ')} for ${recipe.title}; cool it quickly in shallow containers, refrigerate near-term portions, and freeze portions for later than Wednesday.`
          : `Cook ${grainsOrBeans.join(', ')} for ${recipe.title}; cool it quickly in shallow containers and refrigerate promptly.`,
        ['Cooked grains and beans are efficient batch-prep components when cooled and stored promptly.'],
        0.86,
      );
    }

    const lunchMeals = meals.filter((meal) => meal.mealType === 'lunch');
    if (lunchMeals.length) {
      const lateLunches = lunchMeals.filter((meal) => parseDateKey(meal.date) - sundayPrepDay > 3);
      addTask(
        'portion-lunch', recipe, lunchMeals.map((meal) => meal.date).sort(compareText),
        lateLunches.length
          ? `Portion ${recipe.title} on Sunday; refrigerate near-term lunches and freeze portions for ${lateLunches.map((meal) => meal.date).join(', ')}.`
          : `Portion ${recipe.title} on Sunday and refrigerate it promptly in shallow, covered containers.`,
        ['All lunches are modeled as Sunday meal prep; later-week portions need colder long-term storage.'],
        0.9,
      );
      if (lateLunches.length) {
        addWarning(
          'refrigerated-lunch', recipe, lateLunches.map((meal) => meal.date).sort(compareText),
          `Sunday-prepped ${recipe.title} is scheduled beyond a conservative three-day refrigerated window.`,
          'Freeze those portions on Sunday and thaw them overnight in the refrigerator before eating.',
        );
      }
    }
  }

  return {
    date: dateKeyFromDay(sundayPrepDay),
    tasks,
    warnings,
    confidence,
  };
}

function buildDataQuality(
  profiles: readonly RecipeProfile[],
  groceryItems: readonly GroceryItem[],
): RecommendationDataQuality {
  const uniqueIngredients = new Map<string, { matched: boolean }>();
  for (const profile of profiles) {
    for (const ingredient of profile.ingredients) {
      uniqueIngredients.set(`${profile.recipe.id}:${ingredient.ingredient.id}`, { matched: ingredient.purchaseDay !== null });
    }
  }
  const totalIngredients = uniqueIngredients.size;
  const matchedIngredients = [...uniqueIngredients.values()].filter((ingredient) => ingredient.matched).length;
  const purchaseCoverage = roundRatio(matchedIngredients, totalIngredients);
  const invalidPurchaseDates = groceryItems.filter((item) => item.purchasedAt && purchaseDay(item.purchasedAt) === null).length;
  const reasons: string[] = [];
  if (!totalIngredients) {
    reasons.push('No structured ingredients were available for freshness analysis.');
  } else if (!matchedIngredients) {
    reasons.push('No recipe ingredients have usable purchase timestamps; all ordering is heuristic.');
  } else if (matchedIngredients < totalIngredients) {
    reasons.push(`Usable purchase timestamps match ${matchedIngredients} of ${totalIngredients} unique planned ingredients.`);
  } else {
    reasons.push('Every unique planned ingredient has a usable purchase timestamp.');
  }
  if (invalidPurchaseDates) reasons.push(`${invalidPurchaseDates} grocery purchase timestamp${invalidPurchaseDates === 1 ? ' was' : 's were'} invalid and ignored.`);
  reasons.push('Freshness windows are conservative planning heuristics, not a substitute for package dates, temperature history, or inspection.');
  const score = !totalIngredients ? 0.2 : matchedIngredients === totalIngredients ? 0.9 : matchedIngredients ? 0.62 : 0.38;
  return {
    purchaseCoverage,
    matchedIngredients,
    totalIngredients,
    confidence: confidenceFromScore(score),
    reasons,
  };
}

export function optimizeMealWeek(input: MealWeekOptimizerInput): MealWeekRecommendation {
  const startDay = parseDateKey(input.week.startDate);
  const endDay = parseDateKey(input.week.endDate);
  if (endDay < startDay) throw new RangeError('Week end date must not be before its start date.');
  const sundayPrepDay = sundayOnOrBefore(startDay);
  const recipesById = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const profilesByRecipe = new Map<string, RecipeProfile>();
  const unresolvedEntries: UnresolvedMealEntry[] = [];
  const candidates: Candidate[] = [];

  for (const entry of input.mealPlan) {
    const entryDay = tryParseDateKey(entry.date);
    if (entryDay === null) {
      unresolvedEntries.push({ sourceEntryId: entry.id, recipeId: entry.recipeId, originalDate: entry.date, reason: 'invalid-date' });
      continue;
    }
    if (entryDay < startDay || entryDay > endDay) continue;
    const recipe = recipesById.get(entry.recipeId);
    if (!recipe) {
      unresolvedEntries.push({ sourceEntryId: entry.id, recipeId: entry.recipeId, originalDate: entry.date, reason: 'missing-recipe' });
      continue;
    }
    const profile = profilesByRecipe.get(recipe.id) ?? buildRecipeProfile(recipe, input.groceryItems);
    profilesByRecipe.set(recipe.id, profile);
    candidates.push({ source: entry, profile });
  }

  const schedule: RecommendedMeal[] = [];
  for (const mealType of ['breakfast', 'lunch', 'snack', 'dinner'] as const) {
    const group = candidates.filter((candidate) => candidate.source.mealType === mealType);
    const slots = [...group].sort((first, second) => (
      compareText(first.source.date, second.source.date) || compareText(first.source.id, second.source.id)
    ));
    const ordered = [...group].sort(compareCandidates);
    for (let index = 0; index < slots.length; index += 1) {
      schedule.push(buildRecommendedMeal(slots[index].source, ordered[index], sundayPrepDay));
    }
  }
  schedule.sort((first, second) => (
    compareText(first.date, second.date)
    || MEAL_TYPE_ORDER[first.mealType] - MEAL_TYPE_ORDER[second.mealType]
    || compareText(first.slotId, second.slotId)
  ));
  unresolvedEntries.sort((first, second) => (
    compareText(first.originalDate, second.originalDate) || compareText(first.sourceEntryId, second.sourceEntryId)
  ));

  const dataQuality = buildDataQuality([...profilesByRecipe.values()], input.groceryItems);
  const sundayPrep = buildSundayPrep(schedule, input.recipes, sundayPrepDay, dataQuality.confidence);
  return {
    week: {
      startDate: input.week.startDate,
      endDate: input.week.endDate,
      sundayPrepDate: dateKeyFromDay(sundayPrepDay),
    },
    schedule,
    sundayPrep,
    unresolvedEntries,
    dataQuality,
  };
}

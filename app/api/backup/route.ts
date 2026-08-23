import { NextResponse } from 'next/server';
import { groceryCategoryFor, makeId, normalizeIngredientName, rational } from '../../../lib/domain';
import { getBootstrapData, mergeBackup } from '../../../lib/server/database';
import { apiError, cleanText, requireApiUser } from '../../../lib/server/http';
import { validateRecipe } from '../../../lib/server/validation';
import type {
  GroceryCategory,
  GroceryItem,
  HouseholdPreferences,
  MealPlanEntry,
  MealType,
  Rational,
  RecipeContribution,
} from '../../../lib/types';

const GROCERY_CATEGORIES: GroceryCategory[] = [
  'Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry',
  'Canned & Jarred', 'Pasta, Rice & Grains', 'Spices & Seasonings',
  'Sauces & Condiments', 'Other',
];
const GROCERY_CATEGORY_SET = new Set<GroceryCategory>(GROCERY_CATEGORIES);

export async function GET() {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before exporting your cookbook.', 401);
  const data = await getBootstrapData({ displayName: user.displayName, email: user.email });
  const backup = {
    format: 'savor-household-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    recipes: data.recipes,
    mealPlan: data.mealPlan,
    groceryItems: data.groceryItems,
    preferences: data.preferences,
  };
  return NextResponse.json(backup, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="savor-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}

function validMeal(value: unknown): MealPlanEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || typeof row.recipeId !== 'string') return null;
  const mealType = ['breakfast', 'lunch', 'dinner'].includes(String(row.mealType)) ? row.mealType as MealType : 'dinner';
  const servings = row.servings === null || row.servings === undefined ? null : Number(row.servings);
  return {
    id: typeof row.id === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(row.id) ? row.id : makeId('meal'),
    date: row.date, mealType, recipeId: cleanText(row.recipeId, 160),
    servings: Number.isFinite(servings) ? servings : null,
    revision: Number(row.revision) || 1,
    dateModified: cleanText(row.dateModified, 60) || new Date().toISOString(),
  };
}

function validRational(value: unknown): Rational | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const numerator = Number(row.numerator);
  const denominator = Number(row.denominator);
  if (
    !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
    Math.abs(numerator) > 1_000_000 || denominator < 1 || denominator > 1_000_000
  ) return null;
  return rational(numerator, denominator);
}

function validContribution(value: unknown): RecipeContribution | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const recipeId = cleanText(row.recipeId, 160);
  const ingredientId = cleanText(row.ingredientId, 160);
  const recipeTitle = cleanText(row.recipeTitle, 240);
  const rawText = cleanText(row.rawText, 500);
  if (
    !/^[A-Za-z0-9_-]{3,160}$/.test(recipeId) ||
    !/^[A-Za-z0-9_-]{3,160}$/.test(ingredientId) ||
    !recipeTitle || !rawText
  ) return null;
  return {
    recipeId,
    recipeTitle,
    ingredientId,
    rawText,
    quantity: validRational(row.quantity),
    unit: cleanText(row.unit, 40) || null,
  };
}

function validPreferences(value: unknown): HouseholdPreferences | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    !Array.isArray(row.pantryStaples) ||
    !Array.isArray(row.sectionOrder) ||
    typeof row.excludePantryStaples !== 'boolean'
  ) return null;
  const pantryStaples = [...new Set(row.pantryStaples.slice(0, 250)
    .map((item) => cleanText(item, 240).toLowerCase())
    .filter(Boolean))];
  const suppliedOrder = row.sectionOrder.slice(0, GROCERY_CATEGORIES.length)
    .filter((item): item is GroceryCategory => GROCERY_CATEGORY_SET.has(item as GroceryCategory));
  const sectionOrder = [
    ...new Set(suppliedOrder),
    ...GROCERY_CATEGORIES.filter((category) => !suppliedOrder.includes(category)),
  ];
  return { pantryStaples, sectionOrder, excludePantryStaples: row.excludePantryStaples };
}

function validGrocery(value: unknown): GroceryItem | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const ingredientName = cleanText(row.ingredientName, 240);
  if (!ingredientName) return null;
  const normalizedIngredient = normalizeIngredientName(cleanText(row.normalizedIngredient, 240) || ingredientName);
  const groceryCategory = GROCERY_CATEGORY_SET.has(row.groceryCategory as GroceryCategory)
    ? row.groceryCategory as GroceryCategory
    : groceryCategoryFor(normalizedIngredient);
  const recipeContributions = Array.isArray(row.recipeContributions)
    ? row.recipeContributions.slice(0, 300).map(validContribution)
      .filter((item): item is RecipeContribution => Boolean(item))
    : [];
  return {
    id: typeof row.id === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(row.id) ? row.id : makeId('grocery'),
    ingredientName,
    normalizedIngredient,
    quantity: validRational(row.quantity),
    unit: cleanText(row.unit, 40) || null,
    groceryCategory,
    checked: Boolean(row.checked), manual: Boolean(row.manual),
    recipeContributions, revision: Number(row.revision) || 1,
    dateModified: cleanText(row.dateModified, 60) || new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before importing a backup.', 401);
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 5_000_000) return apiError('Backups must be smaller than 5 MB.', 413);
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.format !== 'savor-household-backup' || body.version !== 1) return apiError('This is not a supported Savor backup.', 400);
    const recipeRows = Array.isArray(body.recipes) ? body.recipes.slice(0, 500).map(validateRecipe) : [];
    const mealRows = Array.isArray(body.mealPlan) ? body.mealPlan.slice(0, 1_000).map(validMeal).filter((item): item is MealPlanEntry => Boolean(item)) : [];
    const groceryRows = Array.isArray(body.groceryItems) ? body.groceryItems.slice(0, 1_000).map(validGrocery).filter((item): item is GroceryItem => Boolean(item)) : [];
    const preferences = body.preferences === undefined ? undefined : validPreferences(body.preferences);
    if (body.preferences !== undefined && !preferences) return apiError('Backup preferences are invalid.', 400);
    await mergeBackup({ recipes: recipeRows, mealPlan: mealRows, groceryItems: groceryRows, preferences: preferences ?? undefined });
    return NextResponse.json({ ok: true, processed: { recipes: recipeRows.length, meals: mealRows.length, groceryItems: groceryRows.length } });
  } catch {
    return apiError('The backup could not be validated. Your current data was not changed.', 400);
  }
}

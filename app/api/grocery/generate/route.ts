import { NextResponse } from 'next/server';
import { aggregateRecipes } from '../../../../lib/domain';
import { getPreferences, getRecipesByIds, replaceGeneratedGroceryItems } from '../../../../lib/server/database';
import { apiError, requireApiUser } from '../../../../lib/server/http';

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before generating a grocery list.', 401);
  try {
    const body = await request.json() as Record<string, unknown>;
    const occurrences = Array.isArray(body.occurrences)
      ? body.occurrences.flatMap((value) => {
          if (!value || typeof value !== 'object') return [];
          const row = value as Record<string, unknown>;
          if (typeof row.recipeId !== 'string' || !/^[A-Za-z0-9_-]{3,160}$/.test(row.recipeId)) return [];
          const servings = row.servings === null ? null : Number(row.servings);
          if (servings !== null && (!Number.isFinite(servings) || servings <= 0 || servings > 1000)) return [];
          return [{ recipeId: row.recipeId, servings }];
        }).slice(0, 200)
      : [];
    const requestedRecipeIds = Array.isArray(body.recipeIds)
      ? [...new Set(body.recipeIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(id)))].slice(0, 100)
      : [];
    const recipeIds = [...new Set(occurrences.length ? occurrences.map((entry) => entry.recipeId) : requestedRecipeIds)];
    if (!recipeIds.length) return apiError('Select at least one planned recipe first.', 400);
    const servingsByRecipe = body.servingsByRecipe && typeof body.servingsByRecipe === 'object'
      ? body.servingsByRecipe as Record<string, number | null>
      : {};
    const [selectedRecipes, preferences] = await Promise.all([getRecipesByIds(recipeIds), getPreferences()]);
    const items = aggregateRecipes(
      selectedRecipes,
      servingsByRecipe,
      preferences.excludePantryStaples ? preferences.pantryStaples : [],
      occurrences,
    );
    return NextResponse.json({ items: await replaceGeneratedGroceryItems(items), excludedStaples: preferences.excludePantryStaples ? preferences.pantryStaples.length : 0 });
  } catch {
    return apiError('The grocery list could not be generated.', 500, ['Try again', 'Add items manually']);
  }
}

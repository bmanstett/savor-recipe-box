import { NextResponse } from 'next/server';
import { makeId } from '../../../lib/domain';
import { upsertMealEntry } from '../../../lib/server/database';
import { apiError, requireApiUser } from '../../../lib/server/http';
import type { MealPlanEntry, MealType } from '../../../lib/types';

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before planning a meal.', 401);
  try {
    const body = await request.json() as Record<string, unknown>;
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
    const recipeId = typeof body.recipeId === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(body.recipeId) ? body.recipeId : null;
    const mealType = ['breakfast', 'lunch', 'dinner'].includes(String(body.mealType)) ? body.mealType as MealType : 'dinner';
    const servings = body.servings === null || body.servings === undefined ? null : Number(body.servings);
    if (!date || !recipeId || (servings !== null && (!Number.isFinite(servings) || servings < 1 || servings > 10_000))) {
      return apiError('Choose a valid recipe, date, and serving size.', 400);
    }
    const entry: MealPlanEntry = {
      id: typeof body.id === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(body.id) ? body.id : makeId('meal'),
      date, mealType, recipeId, servings,
      revision: Number(body.revision) || 1,
      dateModified: new Date().toISOString(),
    };
    return NextResponse.json(await upsertMealEntry(entry), { status: 201 });
  } catch {
    return apiError('That meal could not be planned.', 400);
  }
}

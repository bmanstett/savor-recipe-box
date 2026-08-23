import { NextResponse } from 'next/server';
import { deleteMealEntry, upsertMealEntry } from '../../../../lib/server/database';
import { apiError, requireApiUser } from '../../../../lib/server/http';
import type { MealPlanEntry, MealType } from '../../../../lib/types';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before changing the meal plan.', 401);
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(id)) return apiError('That meal identifier is invalid.', 400);
  try {
    const body = await request.json() as Partial<MealPlanEntry>;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '') || !body.recipeId || !/^[A-Za-z0-9_-]{3,160}$/.test(body.recipeId)) return apiError('Meal plan data is incomplete.', 400);
    if (body.servings !== null && body.servings !== undefined && (!Number.isInteger(body.servings) || body.servings < 1 || body.servings > 1_000)) return apiError('Servings must be between 1 and 1,000.', 400);
    if (body.revision !== undefined && (!Number.isInteger(body.revision) || body.revision < 0)) return apiError('Meal revision is invalid.', 400);
    const entry: MealPlanEntry = {
      id, date: body.date!, recipeId: body.recipeId,
      mealType: (['breakfast', 'lunch', 'dinner'].includes(body.mealType ?? '') ? body.mealType : 'dinner') as MealType,
      servings: body.servings ?? null, revision: (body.revision ?? 0) + 1,
      dateModified: new Date().toISOString(),
    };
    return NextResponse.json(await upsertMealEntry(entry));
  } catch {
    return apiError('That meal could not be changed.', 400);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before changing the meal plan.', 401);
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(id)) return apiError('That meal identifier is invalid.', 400);
  return NextResponse.json({ ok: await deleteMealEntry(id) });
}

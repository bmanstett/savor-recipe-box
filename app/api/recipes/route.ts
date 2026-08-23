import { NextResponse } from 'next/server';
import { upsertRecipe } from '../../../lib/server/database';
import { apiError, requireApiUser } from '../../../lib/server/http';
import { validateRecipe } from '../../../lib/server/validation';

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before saving a recipe.', 401);
  try {
    const recipe = validateRecipe(await request.json());
    const saved = await upsertRecipe(recipe);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'This recipe could not be saved.', 400);
  }
}

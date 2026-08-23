import { NextResponse } from 'next/server';
import { patchRecipe } from '../../../../lib/server/database';
import { apiError, cleanText, requireApiUser } from '../../../../lib/server/http';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before changing a recipe.', 401);
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(id)) return apiError('That recipe identifier is invalid.', 400);
  try {
    const body = await request.json() as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ('favorite' in body) {
      if (typeof body.favorite !== 'boolean') return apiError('Favorite must be true or false.', 400);
      patch.favorite = body.favorite;
    }
    if ('rating' in body) {
      if (body.rating !== null && (!Number.isInteger(body.rating) || Number(body.rating) < 1 || Number(body.rating) > 5)) return apiError('Rating must be between 1 and 5.', 400);
      patch.rating = body.rating;
    }
    if ('notes' in body) patch.notes = cleanText(body.notes, 10_000);
    for (const key of ['deletedAt', 'lastCooked'] as const) {
      if (!(key in body)) continue;
      if (body[key] !== null && (typeof body[key] !== 'string' || !Number.isFinite(Date.parse(body[key])))) return apiError(`${key} must be a valid date.`, 400);
      patch[key] = body[key];
    }
    if ('timesCooked' in body) {
      if (!Number.isInteger(body.timesCooked) || Number(body.timesCooked) < 0 || Number(body.timesCooked) > 100_000) return apiError('Times cooked is invalid.', 400);
      patch.timesCooked = body.timesCooked;
    }
    if (!Object.keys(patch).length) return apiError('No supported recipe changes were provided.', 400);
    const saved = await patchRecipe(id, patch);
    return saved ? NextResponse.json(saved) : apiError('Recipe not found.', 404);
  } catch {
    return apiError('That change could not be saved.', 400);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before deleting a recipe.', 401);
  const { id } = await context.params;
  const saved = await patchRecipe(id, { deletedAt: new Date().toISOString() });
  return saved ? NextResponse.json({ ok: true, recipe: saved }) : apiError('Recipe not found.', 404);
}

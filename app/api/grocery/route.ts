import { NextResponse } from 'next/server';
import { makeId, parseIngredientLine } from '../../../lib/domain';
import { upsertGroceryItem } from '../../../lib/server/database';
import { apiError, cleanText, requireApiUser } from '../../../lib/server/http';
import type { GroceryItem } from '../../../lib/types';

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before changing the grocery list.', 401);
  try {
    const body = await request.json() as Record<string, unknown>;
    const rawText = cleanText(body.rawText, 500);
    if (!rawText) return apiError('Enter an item to add.', 400);
    const ingredient = parseIngredientLine(rawText);
    const item: GroceryItem = {
      id: typeof body.id === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(body.id) ? body.id : makeId('grocery'),
      ingredientName: ingredient.ingredientName,
      normalizedIngredient: ingredient.normalizedIngredient,
      quantity: ingredient.quantity,
      unit: ingredient.normalizedUnit,
      groceryCategory: ingredient.groceryCategory,
      checked: false,
      manual: true,
      recipeContributions: [],
      revision: 0,
      dateModified: new Date().toISOString(),
    };
    return NextResponse.json(await upsertGroceryItem(item), { status: 201 });
  } catch {
    return apiError('That grocery item could not be added.', 400);
  }
}

import { NextResponse } from 'next/server';
import { deleteGroceryItem, patchGroceryItem } from '../../../../lib/server/database';
import { apiError, cleanText, requireApiUser } from '../../../../lib/server/http';
import type { GroceryCategory, GroceryItem } from '../../../../lib/types';

type Context = { params: Promise<{ id: string }> };
const categories: GroceryCategory[] = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry', 'Canned & Jarred', 'Pasta, Rice & Grains', 'Spices & Seasonings', 'Sauces & Condiments', 'Other'];

export async function PATCH(request: Request, context: Context) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before changing the grocery list.', 401);
  const { id } = await context.params;
  try {
    const body = await request.json() as Partial<GroceryItem>;
    const patch: Partial<GroceryItem> = {};
    if (typeof body.checked === 'boolean') patch.checked = body.checked;
    if (typeof body.ingredientName === 'string') patch.ingredientName = cleanText(body.ingredientName, 240);
    if (body.groceryCategory && categories.includes(body.groceryCategory)) patch.groceryCategory = body.groceryCategory;
    if (body.quantity === null || (body.quantity && Number.isFinite(body.quantity.numerator) && Number.isFinite(body.quantity.denominator) && body.quantity.denominator > 0)) patch.quantity = body.quantity;
    const saved = await patchGroceryItem(id, patch);
    return saved ? NextResponse.json(saved) : apiError('Grocery item not found.', 404);
  } catch {
    return apiError('That grocery item could not be changed.', 400);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before changing the grocery list.', 401);
  const { id } = await context.params;
  return NextResponse.json({ ok: await deleteGroceryItem(id) });
}

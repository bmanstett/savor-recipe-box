import { NextResponse } from 'next/server';
import { getPreferences, savePreferences } from '../../../lib/server/database';
import { apiError, cleanText, requireApiUser } from '../../../lib/server/http';
import type { GroceryCategory, HouseholdPreferences } from '../../../lib/types';

const categories: GroceryCategory[] = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry', 'Canned & Jarred', 'Pasta, Rice & Grains', 'Spices & Seasonings', 'Sauces & Condiments', 'Other'];

export async function GET() {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in to view household settings.', 401);
  return NextResponse.json(await getPreferences());
}

export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in to change household settings.', 401);
  try {
    const body = await request.json() as Partial<HouseholdPreferences>;
    const current = await getPreferences();
    const preferences: HouseholdPreferences = {
      pantryStaples: Array.isArray(body.pantryStaples)
        ? body.pantryStaples.slice(0, 100).map((item) => cleanText(item, 120).toLowerCase()).filter(Boolean)
        : current.pantryStaples,
      excludePantryStaples: typeof body.excludePantryStaples === 'boolean' ? body.excludePantryStaples : current.excludePantryStaples,
      sectionOrder: Array.isArray(body.sectionOrder)
        ? [...new Set(body.sectionOrder.filter((item): item is GroceryCategory => categories.includes(item as GroceryCategory)))]
        : current.sectionOrder,
    };
    return NextResponse.json(await savePreferences(preferences));
  } catch {
    return apiError('Household settings could not be saved.', 400);
  }
}

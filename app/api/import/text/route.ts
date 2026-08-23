import { NextResponse } from 'next/server';
import { parseRecipeText } from '../../../../lib/domain';
import { apiError, cleanText, requireApiUser } from '../../../../lib/server/http';

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before importing a recipe.', 401);
  try {
    const body = await request.json() as Record<string, unknown>;
    const text = cleanText(body.text, 30_000);
    if (text.length < 8) return apiError('Paste the recipe text you want to import.', 400);
    const result = parseRecipeText(text);
    return NextResponse.json({ ...result, provider: 'text-parser' });
  } catch {
    return apiError('That text could not be read as a recipe.', 400, ['Paste again', 'Create manually']);
  }
}

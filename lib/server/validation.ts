import { groceryCategoryFor, makeId, normalizeIngredientName, rational } from '../domain';
import type { Attachment, GroceryCategory, Ingredient, Instruction, Recipe, SourceType } from '../types';
import { cleanText, safeHttpUrl } from './http';

const SOURCE_TYPES = new Set<SourceType>(['url', 'photo', 'screenshot', 'pasted-text', 'manual']);
const GROCERY_CATEGORIES = new Set<GroceryCategory>([
  'Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry',
  'Canned & Jarred', 'Pasta, Rice & Grains', 'Spices & Seasonings',
  'Sauces & Condiments', 'Other',
]);

function boundedNumber(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function safeId(value: unknown, prefix: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(value) ? value : makeId(prefix);
}

function safeImageUrl(value: unknown): string | null {
  const text = cleanText(value, 2_048);
  if (!text) return null;
  if (/^\/(?:api\/files|recipes)\/[A-Za-z0-9_./-]+$/.test(text)) return text;
  return safeHttpUrl(text);
}

function validateIngredient(value: unknown, index: number): Ingredient | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const ingredientName = cleanText(input.ingredientName, 240);
  if (!ingredientName) return null;
  const numerator = boundedNumber((input.quantity as Record<string, unknown> | null)?.numerator, 0, 1_000_000);
  const denominator = boundedNumber((input.quantity as Record<string, unknown> | null)?.denominator, 1, 1_000_000);
  const quantity = numerator !== null && denominator !== null ? rational(numerator, denominator) : null;
  const normalizedIngredient = normalizeIngredientName(cleanText(input.normalizedIngredient, 240) || ingredientName);
  const category = GROCERY_CATEGORIES.has(input.groceryCategory as GroceryCategory)
    ? input.groceryCategory as GroceryCategory
    : groceryCategoryFor(normalizedIngredient);
  const confidence = boundedNumber(input.confidence, 0, 1) ?? 1;
  const unit = cleanText(input.unit, 40) || null;
  return {
    id: safeId(input.id, `ing${index}`),
    rawText: cleanText(input.rawText, 500) || ingredientName,
    quantity, unit, normalizedUnit: cleanText(input.normalizedUnit, 40) || unit,
    ingredientName, normalizedIngredient,
    descriptor: cleanText(input.descriptor, 80) || null,
    preparation: cleanText(input.preparation, 160) || null,
    groceryCategory: category,
    optional: Boolean(input.optional),
    section: cleanText(input.section, 100) || null,
    confidence,
    needsReview: Boolean(input.needsReview) || confidence < 0.75,
  };
}

function validateInstruction(value: unknown, index: number): Instruction | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const text = cleanText(input.text, 4_000);
  if (!text) return null;
  return {
    id: safeId(input.id, `step${index}`),
    stepNumber: index + 1,
    section: cleanText(input.section, 100) || null,
    text,
    timerMinutes: boundedNumber(input.timerMinutes, 1, 1_440),
  };
}

function validateAttachment(value: unknown, index: number): Attachment | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const url = safeImageUrl(input.url);
  if (!url) return null;
  const type = input.type === 'screenshot' || input.type === 'original-photo' ? input.type : 'other';
  return {
    id: safeId(input.id, `attachment${index}`),
    type,
    url,
    mimeType: cleanText(input.mimeType, 100) || 'image/jpeg',
    originalFilename: cleanText(input.originalFilename, 240) || 'recipe-image',
    captureDate: cleanText(input.captureDate, 60) || new Date().toISOString(),
  };
}

export function validateRecipe(value: unknown): Recipe {
  if (!value || typeof value !== 'object') throw new Error('Recipe data is missing.');
  const input = value as Record<string, unknown>;
  const title = cleanText(input.title, 240);
  if (!title) throw new Error('Give this recipe a title before saving.');
  const now = new Date().toISOString();
  const sourceType = SOURCE_TYPES.has(input.sourceType as SourceType) ? input.sourceType as SourceType : 'manual';
  const ingredients = Array.isArray(input.ingredients)
    ? input.ingredients.slice(0, 300).map(validateIngredient).filter((item): item is Ingredient => Boolean(item))
    : [];
  const instructions = Array.isArray(input.instructions)
    ? input.instructions.slice(0, 200).map(validateInstruction).filter((item): item is Instruction => Boolean(item))
    : [];
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.slice(0, 20).map(validateAttachment).filter((item): item is Attachment => Boolean(item))
    : [];
  const sourceURL = safeHttpUrl(input.sourceURL);
  return {
    id: safeId(input.id, 'recipe'), title,
    description: cleanText(input.description, 2_000),
    heroImage: safeImageUrl(input.heroImage), sourceType, sourceURL,
    sourceName: cleanText(input.sourceName, 240) || (sourceURL ? new URL(sourceURL).hostname.replace(/^www\./, '') : null),
    author: cleanText(input.author, 240) || null,
    servings: boundedNumber(input.servings, 1, 10_000),
    prepTime: boundedNumber(input.prepTime, 0, 100_000),
    cookTime: boundedNumber(input.cookTime, 0, 100_000),
    totalTime: boundedNumber(input.totalTime, 0, 100_000),
    cuisine: cleanText(input.cuisine, 120) || null,
    categories: Array.isArray(input.categories) ? input.categories.slice(0, 30).map((item) => cleanText(item, 80)).filter(Boolean) : [],
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 30).map((item) => cleanText(item, 80)).filter(Boolean) : [],
    ingredients, instructions,
    rating: boundedNumber(input.rating, 1, 5), favorite: Boolean(input.favorite),
    notes: cleanText(input.notes, 10_000), attachments,
    dateAdded: cleanText(input.dateAdded, 60) || now,
    dateModified: now,
    lastCooked: cleanText(input.lastCooked, 60) || null,
    timesCooked: boundedNumber(input.timesCooked, 0, 1_000_000) ?? 0,
    revision: boundedNumber(input.revision, 0, 1_000_000) ?? 0,
    deletedAt: cleanText(input.deletedAt, 60) || null,
  };
}

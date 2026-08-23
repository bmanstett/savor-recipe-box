import { NextResponse } from 'next/server';
import { createBlankDraft, makeId, parseIngredientLine } from '../../../../lib/domain';
import { apiError, cleanText, isPrivateHostname, requireApiUser, safeHttpUrl } from '../../../../lib/server/http';
import type { Instruction, RecipeDraft } from '../../../../lib/types';

const MAX_HTML_BYTES = 2_000_000;

function recipeNode(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recipeNode(item);
      if (found) return found;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  const type = object['@type'];
  if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return object;
  if (object['@graph']) return recipeNode(object['@graph']);
  for (const child of Object.values(object)) {
    const found = recipeNode(child);
    if (found) return found;
  }
  return null;
}

function durationMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);
  if (!match) return null;
  return Number(match[1] ?? 0) * 1_440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function plainText(value: unknown, maxLength = 4_000): string {
  return cleanText(typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ') : '', maxLength).replace(/\s+/g, ' ');
}

function firstImage(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === 'string') return safeHttpUrl(candidate);
  if (candidate && typeof candidate === 'object') return safeHttpUrl((candidate as Record<string, unknown>).url);
  return null;
}

function instructionRows(value: unknown): Instruction[] {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  const output: Instruction[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const text = plainText(row);
      if (text) output.push({ id: makeId('step'), stepNumber: output.length + 1, section: null, text, timerMinutes: null });
    } else if (row && typeof row === 'object') {
      const object = row as Record<string, unknown>;
      if (Array.isArray(object.itemListElement)) {
        const nested = instructionRows(object.itemListElement);
        output.push(...nested.map((item) => ({ ...item, section: plainText(object.name, 100) || null, stepNumber: output.length + item.stepNumber })));
      } else {
        const text = plainText(object.text ?? object.name);
        if (text) output.push({ id: makeId('step'), stepNumber: output.length + 1, section: null, text, timerMinutes: null });
      }
    }
  }
  return output.map((item, index) => ({ ...item, stepNumber: index + 1 }));
}

function servings(value: unknown): number | null {
  const text = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function schemaDraft(node: Record<string, unknown>, url: string): RecipeDraft {
  const draft = createBlankDraft('url');
  draft.title = plainText(node.name, 240) || 'Imported recipe';
  draft.description = plainText(node.description, 2_000);
  draft.heroImage = firstImage(node.image);
  draft.sourceURL = url;
  draft.sourceName = new URL(url).hostname.replace(/^www\./, '');
  draft.author = typeof node.author === 'string'
    ? plainText(node.author, 240)
    : plainText(Array.isArray(node.author) ? (node.author[0] as Record<string, unknown> | undefined)?.name : (node.author as Record<string, unknown> | undefined)?.name, 240) || null;
  draft.servings = servings(node.recipeYield);
  draft.prepTime = durationMinutes(node.prepTime);
  draft.cookTime = durationMinutes(node.cookTime);
  draft.totalTime = durationMinutes(node.totalTime) ??
    (draft.prepTime !== null && draft.cookTime !== null ? draft.prepTime + draft.cookTime : null);
  draft.cuisine = plainText(node.recipeCuisine, 120) || null;
  draft.categories = [plainText(node.recipeCategory, 120)].filter(Boolean);
  const ingredients = Array.isArray(node.recipeIngredient) ? node.recipeIngredient : [];
  draft.ingredients = ingredients.slice(0, 300).map((item) => parseIngredientLine(plainText(item, 500))).filter((item) => item.ingredientName);
  draft.instructions = instructionRows(node.recipeInstructions).slice(0, 200);
  return draft;
}

async function limitedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_HTML_BYTES) throw new Error('too-large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error('too-large');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchRecipePage(start: string): Promise<{ html: string; finalUrl: string }> {
  let current = start;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const parsed = new URL(current);
    if (isPrivateHostname(parsed.hostname)) throw new Error('blocked-host');
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.8', 'User-Agent': 'SavorRecipeImporter/1.0' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect');
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`http-${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (!/html|json|xhtml/i.test(type)) throw new Error('unsupported-content');
    return { html: await limitedText(response), finalUrl: current };
  }
  throw new Error('too-many-redirects');
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before importing a recipe.', 401);
  try {
    const body = await request.json() as Record<string, unknown>;
    const url = safeHttpUrl(body.url);
    if (!url || isPrivateHostname(new URL(url).hostname)) return apiError('Enter a public http or https recipe link.', 400);
    const { html, finalUrl } = await fetchRecipePage(url);
    const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const script of scripts.slice(0, 30)) {
      try {
        const node = recipeNode(JSON.parse(script[1]));
        if (node) {
          const draft = schemaDraft(node, finalUrl);
          if (!draft.ingredients.length || !draft.instructions.length) {
            return NextResponse.json({
              draft,
              warnings: ['Some recipe details were missing from the page. Review before saving.'],
              provider: 'schema-org',
            });
          }
          return NextResponse.json({ draft, warnings: [], provider: 'schema-org' });
        }
      } catch { /* Ignore malformed JSON-LD and continue looking. */ }
    }
    return apiError('This page did not expose a structured recipe.', 422, ['Paste recipe text', 'Upload a screenshot', 'Create manually']);
  } catch {
    return apiError('Savor could not reach or read that recipe page.', 422, ['Try again', 'Paste recipe text', 'Upload a screenshot', 'Create manually']);
  }
}

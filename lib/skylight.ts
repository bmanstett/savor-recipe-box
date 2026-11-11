import type { MealPlanEntry, Recipe, SkylightEmailApp } from './types';

const SKYLIGHT_EMAIL_PATTERN = /^[A-Z0-9][A-Z0-9._+-]{0,63}@ourskylight\.com$/i;
const MEAL_TYPE_ORDER: Record<MealPlanEntry['mealType'], number> = {
  breakfast: 0,
  lunch: 1,
  snack: 2,
  dinner: 3,
};

export interface SkylightEmailDraft {
  body: string;
  mealCount: number;
}

export function isValidSkylightDeviceEmail(value: string): boolean {
  return SKYLIGHT_EMAIL_PATTERN.test(value.trim());
}

export function normalizeSkylightEmailApp(value: unknown): SkylightEmailApp {
  return value === 'device-default' ? 'device-default' : 'gmail';
}

function dateFromKey(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function longDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(dateFromKey(value));
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function formatSkylightWeek(
  entries: MealPlanEntry[],
  recipes: Recipe[],
  startDate: string,
  endDate: string,
): SkylightEmailDraft {
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const planned = entries
    .filter((entry) => entry.date >= startDate && entry.date <= endDate && recipesById.has(entry.recipeId))
    .sort((first, second) => first.date.localeCompare(second.date)
      || MEAL_TYPE_ORDER[first.mealType] - MEAL_TYPE_ORDER[second.mealType]);
  const lines: string[] = [];
  for (const entry of planned) {
    const recipe = recipesById.get(entry.recipeId);
    if (!recipe) continue;
    // Each line is a complete schedule entry. No preamble, recipe instructions,
    // source links or serving counts that Sidekick could classify as a recipe.
    // A link accidentally pasted into a title must not become an import either.
    const title = recipe.title.replace(/(?:https?:\/\/|www\.)\S+/gi, '')
      .replace(/\s+/g, ' ').trim() || 'Planned meal';
    lines.push(`${longDate(entry.date)} — ${capitalize(entry.mealType)}: ${title}`);
  }
  return {
    body: lines.join('\n'),
    mealCount: planned.length,
  };
}

export function skylightMailto(email: string, draft: SkylightEmailDraft): string {
  // Skylight treats the subject as a person/name tag and prepends it to imported meal titles.
  return `mailto:${email.trim().toLowerCase()}?body=${encodeURIComponent(normalizeEmailBody(draft.body))}`;
}

export function skylightGmailComposeUrl(email: string, draft: SkylightEmailDraft): string {
  // Intentionally omit the subject: Skylight prepends subjects to imported meal titles.
  return `googlegmail:///co?to=${encodeURIComponent(email.trim().toLowerCase())}&body=${encodeURIComponent(normalizeEmailBody(draft.body))}`;
}

export function skylightEmailDraftUrl(
  email: string,
  draft: SkylightEmailDraft,
  emailApp: SkylightEmailApp = 'gmail',
): string {
  return emailApp === 'device-default'
    ? skylightMailto(email, draft)
    : skylightGmailComposeUrl(email, draft);
}

function normalizeEmailBody(body: string): string {
  return body.replace(/\r?\n/g, '\r\n');
}

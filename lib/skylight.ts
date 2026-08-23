import type { MealPlanEntry, Recipe } from './types';

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
  const lines = [
    'SAVOR WEEKLY MEAL PLAN',
    `Week: ${longDate(startDate)} through ${longDate(endDate)}`,
    '',
  ];
  let previousDate = '';
  for (const entry of planned) {
    const recipe = recipesById.get(entry.recipeId);
    if (!recipe) continue;
    if (entry.date !== previousDate) {
      if (previousDate) lines.push('');
      lines.push(longDate(entry.date));
      previousDate = entry.date;
    }
    lines.push(`${capitalize(entry.mealType)}: ${recipe.title}`);
    lines.push(`Servings: ${entry.servings ?? recipe.servings ?? 'Not specified'}`);
    if (recipe.sourceURL) lines.push(`Recipe URL: ${recipe.sourceURL}`);
  }
  lines.push('', 'Please import these dated meals into the Skylight Meal Planner.');
  return {
    body: lines.join('\n'),
    mealCount: planned.length,
  };
}

export function skylightMailto(email: string, draft: SkylightEmailDraft): string {
  // Skylight treats the subject as a person/name tag and prepends it to imported meal titles.
  return `mailto:${email.trim().toLowerCase()}?body=${encodeURIComponent(draft.body)}`;
}

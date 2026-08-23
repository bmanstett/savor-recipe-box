import type {
  GroceryCategory,
  GroceryItem,
  Ingredient,
  Rational,
  Recipe,
  RecipeDraft,
} from './types';

const VULGAR_FRACTIONS: Record<string, Rational> = {
  '¼': { numerator: 1, denominator: 4 },
  '⅓': { numerator: 1, denominator: 3 },
  '½': { numerator: 1, denominator: 2 },
  '⅔': { numerator: 2, denominator: 3 },
  '¾': { numerator: 3, denominator: 4 },
  '⅛': { numerator: 1, denominator: 8 },
  '⅜': { numerator: 3, denominator: 8 },
  '⅝': { numerator: 5, denominator: 8 },
  '⅞': { numerator: 7, denominator: 8 },
};

type UnitDefinition = {
  code: string;
  family: string;
  factor: number;
  aliases: string[];
};

const UNIT_DEFINITIONS: UnitDefinition[] = [
  { code: 'fl oz', family: 'volume-us', factor: 6, aliases: ['fluid ounces', 'fluid ounce', 'fl. oz.', 'fl oz'] },
  { code: 'tbsp', family: 'volume-us', factor: 3, aliases: ['tablespoons', 'tablespoon', 'tbsps', 'tbsp.', 'tbsp'] },
  { code: 'tsp', family: 'volume-us', factor: 1, aliases: ['teaspoons', 'teaspoon', 'tsps', 'tsp.', 'tsp'] },
  { code: 'cup', family: 'volume-us', factor: 48, aliases: ['cups', 'cup'] },
  { code: 'pint', family: 'volume-us', factor: 96, aliases: ['pints', 'pint', 'pt'] },
  { code: 'quart', family: 'volume-us', factor: 192, aliases: ['quarts', 'quart', 'qt'] },
  { code: 'lb', family: 'mass-us', factor: 16, aliases: ['pounds', 'pound', 'lbs.', 'lbs', 'lb.', 'lb'] },
  { code: 'oz', family: 'mass-us', factor: 1, aliases: ['ounces', 'ounce', 'oz.', 'oz'] },
  { code: 'kg', family: 'mass-metric', factor: 1000, aliases: ['kilograms', 'kilogram', 'kgs', 'kg'] },
  { code: 'g', family: 'mass-metric', factor: 1, aliases: ['grams', 'gram', 'g'] },
  { code: 'l', family: 'volume-metric', factor: 1000, aliases: ['litres', 'litre', 'liters', 'liter', 'l'] },
  { code: 'ml', family: 'volume-metric', factor: 1, aliases: ['millilitres', 'millilitre', 'milliliters', 'milliliter', 'ml'] },
  { code: 'dozen', family: 'count', factor: 12, aliases: ['dozens', 'dozen'] },
  { code: 'each', family: 'count', factor: 1, aliases: ['each', 'count'] },
  { code: 'clove', family: 'opaque:clove', factor: 1, aliases: ['cloves', 'clove'] },
  { code: 'can', family: 'opaque:can', factor: 1, aliases: ['cans', 'can'] },
  { code: 'jar', family: 'opaque:jar', factor: 1, aliases: ['jars', 'jar'] },
  { code: 'package', family: 'opaque:package', factor: 1, aliases: ['packages', 'package', 'pkgs', 'pkg'] },
  { code: 'bunch', family: 'opaque:bunch', factor: 1, aliases: ['bunches', 'bunch'] },
  { code: 'slice', family: 'opaque:slice', factor: 1, aliases: ['slices', 'slice'] },
];

const UNIT_ALIASES = UNIT_DEFINITIONS.flatMap((definition) =>
  definition.aliases.map((alias) => ({ ...definition, alias })),
).sort((a, b) => b.alias.length - a.alias.length);

const PLURAL_MAP: Record<string, string> = {
  onions: 'onion', tomatoes: 'tomato', potatoes: 'potato', eggs: 'egg', cloves: 'clove',
  carrots: 'carrot', lemons: 'lemon', limes: 'lime', breasts: 'breast', scallions: 'green onion',
};

const SYNONYMS: Record<string, string> = {
  scallion: 'green onion', scallions: 'green onion', 'confectioners sugar': 'powdered sugar',
};

const PREPARATION_WORDS = [
  'diced', 'minced', 'chopped', 'sliced', 'grated', 'shredded', 'divided', 'melted',
  'softened', 'drained', 'rinsed', 'peeled', 'crushed', 'zested', 'juiced',
];

const CATEGORY_RULES: Array<[RegExp, GroceryCategory]> = [
  [/\b(chicken|beef|pork|salmon|shrimp|turkey|sausage|steak)\b/i, 'Meat & Seafood'],
  [/\b(milk|cream|butter|cheese|mozzarella|parmesan|yogurt|egg)\b/i, 'Dairy & Eggs'],
  [/\b(salt|black pepper|cumin|paprika|oregano|thyme|rosemary|cinnamon|nutmeg|seasoning|chili powder|pepper flakes)\b/i, 'Spices & Seasonings'],
  [/\b(onion|garlic|tomato|potato|carrot|lemon|lime|bell pepper|spinach|basil|parsley|cilantro|avocado|lettuce|ginger|cucumber|cabbage)\b/i, 'Produce'],
  [/\b(bread|roll|tortilla|baguette|bun)\b/i, 'Bakery'],
  [/\b(pasta|rice|quinoa|noodle|couscous|oat)\b/i, 'Pasta, Rice & Grains'],
  [/\b(oil|vinegar|mustard|mayonnaise|ketchup|soy sauce|hot sauce|salsa)\b/i, 'Sauces & Condiments'],
  [/\b(bean|chickpea|lentil|broth|stock|flour|sugar|honey|tomato paste)\b/i, 'Pantry'],
];

const DISPLAY_FRACTIONS: Record<string, string> = {
  '1/8': '⅛', '1/4': '¼', '1/3': '⅓', '3/8': '⅜', '1/2': '½',
  '5/8': '⅝', '2/3': '⅔', '3/4': '¾', '7/8': '⅞',
};

export function makeId(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

export function rational(numerator: number, denominator = 1): Rational {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error('Invalid quantity');
  }
  const sign = denominator < 0 ? -1 : 1;
  const divisor = gcd(numerator, denominator);
  return { numerator: (numerator / divisor) * sign, denominator: Math.abs(denominator / divisor) };
}

export function addRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function divideRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

export function formatRational(value: Rational | null): string {
  if (!value) return '';
  const reduced = rational(value.numerator, value.denominator);
  const whole = Math.trunc(reduced.numerator / reduced.denominator);
  const remainder = Math.abs(reduced.numerator % reduced.denominator);
  if (!remainder) return String(whole);
  const fraction = DISPLAY_FRACTIONS[`${remainder}/${reduced.denominator}`] ?? `${remainder}/${reduced.denominator}`;
  return whole ? `${whole}${fraction}` : fraction;
}

export function parseRationalToken(value: string): Rational | null {
  const token = value.trim();
  if (!token) return null;
  const mixedAscii = token.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedAscii) return addRational(rational(Number(mixedAscii[1])), rational(Number(mixedAscii[2]), Number(mixedAscii[3])));
  const simpleAscii = token.match(/^(\d+)\/(\d+)$/);
  if (simpleAscii && Number(simpleAscii[2]) !== 0) return rational(Number(simpleAscii[1]), Number(simpleAscii[2]));
  const mixedVulgar = token.match(/^(\d+)([¼⅓½⅔¾⅛⅜⅝⅞])$/);
  if (mixedVulgar) return addRational(rational(Number(mixedVulgar[1])), VULGAR_FRACTIONS[mixedVulgar[2]]);
  if (VULGAR_FRACTIONS[token]) return VULGAR_FRACTIONS[token];
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    if (!token.includes('.')) return rational(Number(token));
    const places = token.split('.')[1].length;
    return rational(Math.round(Number(token) * 10 ** places), 10 ** places);
  }
  return null;
}

function unitDefinition(code: string | null): UnitDefinition | null {
  return UNIT_DEFINITIONS.find((definition) => definition.code === code) ?? null;
}

function normalizeUnitPrefix(value: string): { code: string | null; rest: string; ambiguous: boolean } {
  const lower = value.toLowerCase();
  for (const unit of UNIT_ALIASES) {
    if (lower === unit.alias || lower.startsWith(`${unit.alias} `)) {
      return { code: unit.code, rest: value.slice(unit.alias.length).trim(), ambiguous: false };
    }
  }
  if (/^[tTcC]\b/.test(value)) return { code: null, rest: value, ambiguous: true };
  return { code: 'each', rest: value, ambiguous: false };
}

function singularizeLastWord(value: string): string {
  const words = value.split(' ');
  const last = words.at(-1) ?? '';
  if (PLURAL_MAP[last]) words[words.length - 1] = PLURAL_MAP[last];
  return words.join(' ');
}

export function normalizeIngredientName(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,;\s]+|[,;\s]+$/g, '');
  const synonym = SYNONYMS[cleaned];
  return synonym ?? singularizeLastWord(cleaned);
}

export function groceryCategoryFor(name: string): GroceryCategory {
  return CATEGORY_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? 'Other';
}

export function parseIngredientLine(rawText: string, section: string | null = null): Ingredient {
  const normalized = rawText.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const rangeMatch = normalized.match(/^(\d+(?:\/\d+)?)\s*(?:-|–|to)\s*(\d+(?:\/\d+)?)(?:\s+|$)/i);
  const quantityMatch = normalized.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+[¼⅓½⅔¾⅛⅜⅝⅞]|[¼⅓½⅔¾⅛⅜⅝⅞]|\d+(?:\.\d+)?)(?:\s+|$)/);
  let rest = normalized;
  let quantity: Rational | null = null;
  let needsReview = Boolean(rangeMatch);
  if (quantityMatch && !rangeMatch) {
    quantity = parseRationalToken(quantityMatch[1]);
    rest = normalized.slice(quantityMatch[0].length).trim();
  }

  const unit = normalizeUnitPrefix(rest);
  rest = unit.rest;
  needsReview ||= unit.ambiguous;

  const commaIndex = rest.indexOf(',');
  let preparation: string | null = null;
  if (commaIndex >= 0) {
    const suffix = rest.slice(commaIndex + 1).trim();
    if (PREPARATION_WORDS.some((word) => suffix.toLowerCase().startsWith(word)) || suffix.toLowerCase().startsWith('plus more')) {
      preparation = suffix;
      rest = rest.slice(0, commaIndex).trim();
    }
  }

  let descriptor: string | null = null;
  const descriptorMatch = rest.match(/^(small|medium|large)\s+(.+)$/i);
  if (descriptorMatch) {
    descriptor = descriptorMatch[1].toLowerCase();
    rest = descriptorMatch[2];
  }

  const ingredientName = rest || normalized;
  const normalizedIngredient = normalizeIngredientName(
    descriptor ? `${descriptor} ${ingredientName}` : ingredientName,
  );
  needsReview ||= !quantity || !ingredientName || /\bor\b/i.test(ingredientName) || /[<>]/.test(ingredientName);

  return {
    id: makeId('ing'), rawText: normalized, quantity,
    unit: quantity ? unit.code : null,
    normalizedUnit: quantity ? unit.code : null,
    ingredientName, normalizedIngredient, descriptor, preparation,
    groceryCategory: groceryCategoryFor(normalizedIngredient),
    optional: /\boptional\b/i.test(normalized), section,
    confidence: needsReview ? 0.62 : 0.96, needsReview,
  };
}

function emptyDraft(sourceType: RecipeDraft['sourceType']): RecipeDraft {
  return {
    id: makeId('recipe'), title: '', description: '', heroImage: null,
    sourceType, sourceURL: null, sourceName: null, author: null,
    servings: null, prepTime: null, cookTime: null, totalTime: null,
    cuisine: null, categories: [], tags: [], ingredients: [], instructions: [],
    rating: null, favorite: false, notes: '', attachments: [],
  };
}

function parseMinutes(text: string, label: string): number | null {
  const match = text.match(new RegExp(`${label}(?:\\s+time)?\\s*[:–-]?\\s*(\\d+)\\s*(?:min|minutes|mins)`, 'i'));
  return match ? Number(match[1]) : null;
}

export function parseRecipeText(text: string): { draft: RecipeDraft; warnings: string[] } {
  const source = text.replace(/\r/g, '').slice(0, 30_000);
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const draft = emptyDraft('pasted-text');
  draft.title = lines[0] || 'Untitled recipe';
  const wholeText = lines.join('\n');
  draft.servings = Number(wholeText.match(/\bserves?\s*[:–-]?\s*(\d+)/i)?.[1] ?? '') || null;
  draft.prepTime = parseMinutes(wholeText, 'prep');
  draft.cookTime = parseMinutes(wholeText, 'cook');
  draft.totalTime = parseMinutes(wholeText, 'total') ??
    (draft.prepTime !== null && draft.cookTime !== null ? draft.prepTime + draft.cookTime : null);

  let mode: 'meta' | 'ingredients' | 'instructions' = 'meta';
  let ingredientSection: string | null = null;
  let instructionSection: string | null = null;
  for (const line of lines.slice(1)) {
    if (/^(ingredients?|what you(?:'|’)ll need)$/i.test(line.replace(/:$/, ''))) { mode = 'ingredients'; continue; }
    if (/^(directions?|instructions?|method|preparation)$/i.test(line.replace(/:$/, ''))) { mode = 'instructions'; continue; }
    if (/^(serves?|prep|cook|total)\b/i.test(line)) continue;
    if (mode === 'meta' && /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+[¼⅓½⅔¾⅛⅜⅝⅞]?|[¼⅓½⅔¾⅛⅜⅝⅞])\s/.test(line)) mode = 'ingredients';
    if (mode === 'ingredients' && /^\d+[.)]\s+/.test(line)) mode = 'instructions';

    if (mode === 'ingredients') {
      const looksLikeSection = /:$/.test(line) && !/^\d/.test(line);
      if (looksLikeSection) { ingredientSection = line.replace(/:$/, ''); continue; }
      draft.ingredients.push(parseIngredientLine(line.replace(/^[-•]\s*/, ''), ingredientSection));
    } else if (mode === 'instructions') {
      const clean = line.replace(/^\d+[.)]\s*/, '').replace(/^[-•]\s*/, '');
      if (/^[A-Za-z][A-Za-z &]+:$/.test(clean)) { instructionSection = clean.replace(/:$/, ''); continue; }
      draft.instructions.push({
        id: makeId('step'), stepNumber: draft.instructions.length + 1,
        section: instructionSection, text: clean,
        timerMinutes: Number(clean.match(/\b(\d+)\s+minutes?\b/i)?.[1] ?? '') || null,
      });
    }
  }

  const warnings: string[] = [];
  if (!draft.ingredients.length) warnings.push('No ingredient lines were confidently detected.');
  if (!draft.instructions.length) warnings.push('No instruction steps were confidently detected.');
  const reviewCount = draft.ingredients.filter((item) => item.needsReview).length;
  if (reviewCount) warnings.push(`${reviewCount} ingredient${reviewCount === 1 ? '' : 's'} need a quick review.`);
  return { draft, warnings };
}

function measureFamily(unit: string | null): string {
  return unitDefinition(unit)?.family ?? `opaque:${unit ?? 'unquantified'}`;
}

function toBase(value: Rational, unit: string | null): Rational {
  return multiplyRational(value, rational(unitDefinition(unit)?.factor ?? 1));
}

function fromBase(value: Rational, unit: string): Rational {
  return divideRational(value, rational(unitDefinition(unit)?.factor ?? 1));
}

function bestDisplayUnit(baseValue: Rational, family: string, contributedUnits: Set<string>): { value: Rational; unit: string } {
  const candidates = UNIT_DEFINITIONS
    .filter((unit) => unit.family === family && (contributedUnits.has(unit.code) || family === 'count'))
    .sort((a, b) => b.factor - a.factor);
  for (const unit of candidates) {
    const value = fromBase(baseValue, unit.code);
    if (value.numerator >= value.denominator && value.denominator <= 8) return { value, unit: unit.code };
  }
  const fallback = candidates.at(-1) ?? { code: [...contributedUnits][0] ?? 'each' };
  return { value: fromBase(baseValue, fallback.code), unit: fallback.code };
}

export function scaleIngredient(ingredient: Ingredient, factor: Rational): Ingredient {
  if (!ingredient.quantity) return ingredient;
  return { ...ingredient, quantity: multiplyRational(ingredient.quantity, factor) };
}

export function formatIngredient(ingredient: Ingredient, factor: Rational = rational(1)): string {
  const scaled = scaleIngredient(ingredient, factor);
  const quantity = formatRational(scaled.quantity);
  const unit = scaled.unit === 'each' ? '' : scaled.unit ?? '';
  return [quantity, unit, ingredient.ingredientName, ingredient.preparation ? `, ${ingredient.preparation}` : '']
    .filter((part) => part !== '').join(' ').replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
}

export function aggregateRecipes(
  recipes: Recipe[],
  servingsByRecipe: Record<string, number | null> = {},
  pantryStaples: string[] = [],
  occurrences: Array<{ recipeId: string; servings: number | null }> = [],
): GroceryItem[] {
  const groups = new Map<string, {
    name: string; normalized: string; family: string; base: Rational | null;
    units: Set<string>; category: GroceryCategory; contributions: GroceryItem['recipeContributions'];
  }>();
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const work = occurrences.length
    ? occurrences.flatMap((occurrence) => {
        const recipe = recipesById.get(occurrence.recipeId);
        return recipe ? [{ recipe, requested: occurrence.servings }] : [];
      })
    : recipes.map((recipe) => ({ recipe, requested: servingsByRecipe[recipe.id] }));
  for (const { recipe, requested } of work) {
    const factor = requested && recipe.servings ? rational(requested, recipe.servings) : rational(1);
    for (const ingredient of recipe.ingredients) {
      if (pantryStaples.includes(ingredient.normalizedIngredient)) continue;
      const family = measureFamily(ingredient.normalizedUnit);
      const safeKey = ingredient.needsReview ? `${recipe.id}:${ingredient.id}` : ingredient.normalizedIngredient;
      const key = `${safeKey}|${family}`;
      const scaled = ingredient.quantity ? multiplyRational(ingredient.quantity, factor) : null;
      const group = groups.get(key) ?? {
        name: ingredient.ingredientName, normalized: ingredient.normalizedIngredient,
        family, base: null, units: new Set<string>(), category: ingredient.groceryCategory, contributions: [],
      };
      if (scaled && ingredient.normalizedUnit) {
        group.base = group.base ? addRational(group.base, toBase(scaled, ingredient.normalizedUnit)) : toBase(scaled, ingredient.normalizedUnit);
        group.units.add(ingredient.normalizedUnit);
      }
      group.contributions.push({
        recipeId: recipe.id, recipeTitle: recipe.title, ingredientId: ingredient.id,
        rawText: ingredient.rawText, quantity: scaled, unit: ingredient.normalizedUnit,
      });
      groups.set(key, group);
    }
  }

  return [...groups.values()].map((group) => {
    const display = group.base ? bestDisplayUnit(group.base, group.family, group.units) : null;
    return {
      id: makeId('grocery'), ingredientName: group.name,
      normalizedIngredient: group.normalized,
      quantity: display?.value ?? null, unit: display?.unit ?? null,
      groceryCategory: group.category, checked: false, manual: false,
      recipeContributions: group.contributions, revision: 1,
      dateModified: new Date().toISOString(),
    };
  }).sort((a, b) => a.groceryCategory.localeCompare(b.groceryCategory) || a.ingredientName.localeCompare(b.ingredientName));
}

export function draftToRecipe(draft: RecipeDraft, now = new Date().toISOString()): Recipe {
  return { ...draft, dateAdded: now, dateModified: now, lastCooked: null, timesCooked: 0, revision: 1, deletedAt: null };
}

export function createBlankDraft(sourceType: RecipeDraft['sourceType'] = 'manual'): RecipeDraft {
  return emptyDraft(sourceType);
}

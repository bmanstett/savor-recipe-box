#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUEST_DIRECTORY = path.join('savor', 'v1', 'imports', 'requests');
const RESULT_DIRECTORY = path.join('savor', 'v1', 'imports', 'results');
const MAX_REQUEST_FILE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 55_000;
const MAX_RELATED_PAGES = 3;
const MAX_NETWORK_REQUESTS = 8;
const MAX_JOBS_DEFAULT = 10;
const USER_AGENT = 'SavorRecipeImporter/1.0 (+https://github.com/bmanstett/savor-recipe-box)';
const READER_ORIGIN = 'https://r.jina.ai/';

const TRACKING_PARAMETERS = new Set([
  'igsh', 'igshid', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

const NON_RECIPE_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com',
  'threads.net', 'www.threads.net',
  'tiktok.com', 'www.tiktok.com',
  'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
  'youtube.com', 'www.youtube.com', 'youtu.be',
  'pinterest.com', 'www.pinterest.com',
  'snapchat.com', 'www.snapchat.com',
]);

const COMMON_HTML_ENTITIES = {
  amp: '&', apos: "'", gt: '>', hellip: '…', ldquo: '“', lsquo: '‘',
  lt: '<', mdash: '—', nbsp: ' ', ndash: '–', quot: '"', rdquo: '”', rsquo: '’',
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanText(value, maxLength = 10_000) {
  return decodeHtmlEntities(String(value ?? ''))
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try { return String.fromCodePoint(codePoint); } catch { return match; }
      }
      return match;
    }
    return COMMON_HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripHtml(value) {
  return cleanText(
    String(value ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6]|section)>/gi, '\n')
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
    100_000,
  );
}

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function emptyDraft(sourceType = 'url') {
  return {
    id: id('recipe'),
    title: '',
    description: '',
    heroImage: null,
    sourceType,
    sourceURL: null,
    sourceName: null,
    author: null,
    servings: null,
    prepTime: null,
    cookTime: null,
    totalTime: null,
    cuisine: null,
    categories: [],
    tags: [],
    ingredients: [],
    instructions: [],
    rating: null,
    favorite: false,
    notes: '',
    attachments: [],
  };
}

function normalizeName(value) {
  return cleanText(value, 500)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groceryCategoryFor(value) {
  const name = normalizeName(value);
  if (/\b(chicken|beef|pork|salmon|shrimp|turkey|sausage|steak|fish|tuna|lamb)\b/i.test(name)) return 'Meat & Seafood';
  if (/\b(milk|cream|butter|cheese|mozzarella|parmesan|yogurt|egg)\b/i.test(name)) return 'Dairy & Eggs';
  if (/\b(salt|pepper|cumin|paprika|oregano|thyme|rosemary|cinnamon|nutmeg|seasoning|spice)\b/i.test(name)) return 'Spices & Seasonings';
  if (/\b(onion|garlic|tomato|potato|carrot|lemon|lime|pepper|spinach|basil|parsley|cilantro|avocado|lettuce|ginger|cucumber|cabbage|apple|banana)\b/i.test(name)) return 'Produce';
  if (/\b(bread|roll|tortilla|baguette|bun)\b/i.test(name)) return 'Bakery';
  if (/\b(pasta|rice|quinoa|noodle|couscous|oat)\b/i.test(name)) return 'Pasta, Rice & Grains';
  if (/\b(oil|vinegar|mustard|mayonnaise|ketchup|soy sauce|hot sauce|salsa)\b/i.test(name)) return 'Sauces & Condiments';
  if (/\b(bean|chickpea|lentil|broth|stock|flour|sugar|honey|tomato paste)\b/i.test(name)) return 'Pantry';
  return 'Other';
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function rational(numerator, denominator = 1) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const divisor = gcd(numerator, denominator);
  const sign = denominator < 0 ? -1 : 1;
  return { numerator: (numerator / divisor) * sign, denominator: Math.abs(denominator / divisor) };
}

const VULGAR_FRACTIONS = {
  '¼': [1, 4], '⅓': [1, 3], '½': [1, 2], '⅔': [2, 3], '¾': [3, 4],
  '⅛': [1, 8], '⅜': [3, 8], '⅝': [5, 8], '⅞': [7, 8],
};

function parseQuantityToken(token) {
  const text = cleanText(token, 30);
  let match = text.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (match) return rational(Number(match[1]) * Number(match[3]) + Number(match[2]), Number(match[3]));
  match = text.match(/^(\d+)\/(\d+)$/);
  if (match) return rational(Number(match[1]), Number(match[2]));
  match = text.match(/^(\d+)([¼⅓½⅔¾⅛⅜⅝⅞])$/);
  if (match) {
    const [numerator, denominator] = VULGAR_FRACTIONS[match[2]];
    return rational(Number(match[1]) * denominator + numerator, denominator);
  }
  if (VULGAR_FRACTIONS[text]) return rational(...VULGAR_FRACTIONS[text]);
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    if (!text.includes('.')) return rational(Number(text));
    const decimalPlaces = text.split('.')[1].length;
    return rational(Math.round(Number(text) * (10 ** decimalPlaces)), 10 ** decimalPlaces);
  }
  return null;
}

const UNIT_ALIASES = [
  ['tablespoons', 'tbsp'], ['tablespoon', 'tbsp'], ['teaspoons', 'tsp'], ['teaspoon', 'tsp'],
  ['fluid ounces', 'fl oz'], ['fluid ounce', 'fl oz'], ['kilograms', 'kg'], ['kilogram', 'kg'],
  ['milliliters', 'ml'], ['millilitres', 'ml'], ['milliliter', 'ml'], ['millilitre', 'ml'],
  ['ounces', 'oz'], ['ounce', 'oz'], ['pounds', 'lb'], ['pound', 'lb'],
  ['packages', 'package'], ['package', 'package'], ['cloves', 'clove'], ['clove', 'clove'],
  ['slices', 'slice'], ['slice', 'slice'], ['cups', 'cup'], ['cup', 'cup'],
  ['tbsp.', 'tbsp'], ['tbsp', 'tbsp'], ['tsp.', 'tsp'], ['tsp', 'tsp'],
  ['grams', 'g'], ['gram', 'g'], ['cans', 'can'], ['can', 'can'],
  ['lbs.', 'lb'], ['lbs', 'lb'], ['lb.', 'lb'], ['lb', 'lb'], ['oz.', 'oz'], ['oz', 'oz'],
  ['kg', 'kg'], ['ml', 'ml'], ['dozen', 'dozen'], ['bunch', 'bunch'],
].sort((a, b) => b[0].length - a[0].length);

function parseIngredient(rawText, section = null) {
  const raw = cleanText(rawText, 1_000).replace(/^[-–—•▪◦*]\s*/, '');
  const quantityMatch = raw.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+[¼⅓½⅔¾⅛⅜⅝⅞]|[¼⅓½⅔¾⅛⅜⅝⅞]|\d+(?:\.\d+)?)(?:\s+|$)/);
  const rangeMatch = raw.match(/^(\d+(?:\.\d+)?(?:\/\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?(?:\/\d+)?)/i);
  const quantity = quantityMatch && !rangeMatch ? parseQuantityToken(quantityMatch[1]) : null;
  let remainder = quantityMatch && !rangeMatch ? raw.slice(quantityMatch[0].length).trim() : raw;
  let unit = null;
  if (quantity) {
    const lower = remainder.toLowerCase();
    const match = UNIT_ALIASES.find(([alias]) => lower === alias || lower.startsWith(`${alias} `));
    if (match) {
      unit = match[1];
      remainder = remainder.slice(match[0].length).trim();
    } else {
      unit = 'each';
    }
  }
  const ingredientName = remainder || raw;
  const normalizedIngredient = normalizeName(ingredientName);
  const needsReview = Boolean(rangeMatch) || !quantity || !normalizedIngredient;
  return {
    id: id('ing'),
    rawText: raw,
    quantity,
    unit: quantity ? unit : null,
    normalizedUnit: quantity ? unit : null,
    ingredientName,
    normalizedIngredient,
    descriptor: null,
    preparation: null,
    groceryCategory: groceryCategoryFor(normalizedIngredient),
    optional: /\boptional\b/i.test(raw),
    section,
    confidence: needsReview ? 0.62 : 0.94,
    needsReview,
  };
}

function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  const text = String(value ?? '').trim();
  if (!text) return null;
  const iso = text.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (iso) {
    const minutes = Number(iso[1] ?? 0) * 1440 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0) + Number(iso[4] ?? 0) / 60;
    return Number.isFinite(minutes) ? Math.round(minutes) : null;
  }
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i)?.[1] ?? 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)/i)?.[1] ?? 0);
  return hours || minutes ? Math.round(hours * 60 + minutes) : null;
}

function firstText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return cleanText(value, 10_000);
  if (Array.isArray(value)) return value.map(firstText).find(Boolean) ?? '';
  if (typeof value === 'object') return firstText(value.name ?? value.text ?? value.url ?? value['@id']);
  return '';
}

function textList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return unique(value.flatMap(textList));
  if (typeof value === 'string') return unique(value.split(/[,;]\s*/).map((item) => cleanText(item, 200)));
  const text = firstText(value);
  return text ? [text] : [];
}

function parseServings(value) {
  const text = firstText(value);
  const match = text.match(/\b(\d+(?:\.\d+)?)\b/);
  return match ? Number(match[1]) : null;
}

function safeDisplayImage(value) {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    const raw = typeof candidate === 'object' && candidate ? candidate.url ?? candidate.contentUrl : candidate;
    try {
      const url = new URL(String(raw ?? ''));
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* Ignore malformed image URLs. */ }
  }
  return null;
}

function instructionText(value) {
  return cleanText(stripHtml(firstText(value)), 5_000);
}

function flattenInstructions(value, section = null, output = [], depth = 0) {
  if (depth > 12 || value == null || output.length >= 200) return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenInstructions(item, section, output, depth + 1);
    return output;
  }
  if (typeof value === 'string') {
    const parts = cleanText(value, 20_000).split(/\n+|(?<=\.)\s+(?=\d+[.)]\s+)/).map((item) => item.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
    for (const text of parts) output.push({ section, text });
    return output;
  }
  if (typeof value !== 'object') return output;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  const isSection = types.some((type) => String(type).toLowerCase() === 'howtosection');
  const nextSection = isSection ? firstText(value.name) || section : section;
  const nested = value.itemListElement ?? value.steps ?? value.recipeInstructions;
  if (nested != null) flattenInstructions(nested, nextSection, output, depth + 1);
  else {
    const text = instructionText(value.text ?? value.name);
    if (text) output.push({ section: nextSection, text });
  }
  return output;
}

function isRecipeNode(value) {
  if (!value || typeof value !== 'object') return false;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  return types.some((type) => String(type).toLowerCase() === 'recipe');
}

function findRecipeNodes(value) {
  const recipes = [];
  const seen = new WeakSet();
  let visited = 0;
  function visit(node, depth) {
    if (depth > 32 || visited >= 20_000 || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    visited += 1;
    if (isRecipeNode(node)) recipes.push(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
    } else {
      for (const child of Object.values(node)) visit(child, depth + 1);
    }
  }
  visit(value, 0);
  return recipes;
}

function parseJsonLdBlock(raw) {
  const cleaned = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\s*\/\/<!\[CDATA\[/, '')
    .replace(/\/\/\]\]>\s*$/, '')
    .trim()
    .replace(/;\s*$/, '');
  const attempts = [cleaned];
  if (/^&quot;|&quot;\s*:/.test(cleaned)) attempts.push(decodeHtmlEntities(cleaned));
  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch { /* Try next conservative normalization. */ }
  }
  return null;
}

export function extractRecipeJsonLd(html) {
  const recipes = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  let scriptsChecked = 0;
  while ((match = scriptPattern.exec(String(html ?? ''))) && scriptsChecked < 200) {
    if (!/\btype\s*=\s*(?:["']\s*)?application\/ld\+json\b/i.test(match[1])) continue;
    scriptsChecked += 1;
    const parsed = parseJsonLdBlock(match[2]);
    if (parsed != null) recipes.push(...findRecipeNodes(parsed));
  }
  return recipes;
}

function draftFromSchemaRecipe(recipe, sourceUrl) {
  const draft = emptyDraft('url');
  draft.title = firstText(recipe.name ?? recipe.headline);
  draft.description = cleanText(stripHtml(firstText(recipe.description)), 2_000);
  draft.heroImage = safeDisplayImage(recipe.image ?? recipe.thumbnailUrl);
  draft.sourceURL = sourceUrl.href;
  draft.sourceName = sourceUrl.hostname.replace(/^www\./, '');
  draft.author = firstText(recipe.author) || null;
  draft.servings = parseServings(recipe.recipeYield ?? recipe.yield);
  draft.prepTime = parseDuration(recipe.prepTime);
  draft.cookTime = parseDuration(recipe.cookTime);
  draft.totalTime = parseDuration(recipe.totalTime)
    ?? (draft.prepTime != null && draft.cookTime != null ? draft.prepTime + draft.cookTime : null);
  draft.cuisine = textList(recipe.recipeCuisine)[0] ?? null;
  draft.categories = textList(recipe.recipeCategory).slice(0, 20);
  draft.tags = textList(recipe.keywords).slice(0, 30);

  const ingredients = Array.isArray(recipe.recipeIngredient ?? recipe.ingredients)
    ? recipe.recipeIngredient ?? recipe.ingredients
    : [recipe.recipeIngredient ?? recipe.ingredients].filter(Boolean);
  draft.ingredients = ingredients
    .map((ingredient) => firstText(ingredient))
    .filter(Boolean)
    .slice(0, 300)
    .map((ingredient) => parseIngredient(ingredient));

  const instructions = flattenInstructions(recipe.recipeInstructions ?? recipe.instructions);
  draft.instructions = instructions.slice(0, 200).map((instruction, index) => ({
    id: id('step'),
    stepNumber: index + 1,
    section: instruction.section,
    text: instruction.text,
    timerMinutes: parseDuration(instruction.text),
  }));
  return draft;
}

function recipeEvidenceScore(draft) {
  if (!draft?.title) return 0;
  return (draft.ingredients?.length ?? 0) * 4
    + (draft.instructions?.length ?? 0) * 5
    + (draft.description ? 1 : 0)
    + (draft.heroImage ? 1 : 0);
}

function bestSchemaDraft(html, sourceUrl) {
  const drafts = extractRecipeJsonLd(html).map((recipe) => draftFromSchemaRecipe(recipe, sourceUrl));
  return drafts.sort((left, right) => recipeEvidenceScore(right) - recipeEvidenceScore(left))[0] ?? null;
}

function normalizeRecipeText(value) {
  return cleanText(value, 75_000)
    .replace(/([0-9])\uFE0F?\u20E3/g, '$1.')
    .replace(/[•●▪◦]\s*/g, '\n• ')
    .replace(/\s+(?=(?:ingredients?|what you(?:'|’)ll need|directions?|instructions?|method|preparation|steps?)\s*[:：])/gi, '\n')
    .replace(/((?:ingredients?|what you(?:'|’)ll need|directions?|instructions?|method|preparation|steps?))\s*[:：]\s*/gi, '$1:\n')
    .replace(/;\s+(?=(?:\d|[¼⅓½⅔¾⅛⅜⅝⅞]))/g, '\n')
    .replace(/\s+(?=\d{1,2}[.)]\s+[A-Z])/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeIngredient(line) {
  return /^(?:[-–—•*]\s*)?(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+[¼⅓½⅔¾⅛⅜⅝⅞]|[¼⅓½⅔¾⅛⅜⅝⅞]|\d+(?:\.\d+)?)(?:\s|$)/.test(line)
    || /^(?:salt|pepper|water|oil)\s+(?:to taste|as needed)$/i.test(line);
}

function headingKind(line) {
  const heading = line.trim().replace(/[^\p{L}'’]+$/gu, '').trim();
  if (/^(?:ingredients?|what you(?:'|’)ll need)$/i.test(heading)) return 'ingredients';
  if (/^(?:directions?|instructions?|method|preparation|steps?)$/i.test(heading)) return 'instructions';
  return null;
}

function titleFromCaption(caption, preferredTitle = '') {
  const lines = normalizeRecipeText(caption).split('\n').map((line) => line.replace(/^[-–—•*]\s*/, '').trim()).filter(Boolean);
  const ingredientHeading = lines.findIndex((line) => headingKind(line) === 'ingredients');
  const preamble = lines.slice(0, ingredientHeading >= 0 ? ingredientHeading : Math.min(lines.length, 8))
    .filter((line) => !headingKind(line) && !/^#/.test(line) && !looksLikeIngredient(line)
      && !/^(?:save|share|follow|comment|recipe below|full recipe)\b/i.test(line));
  const uppercaseTitle = [...preamble].reverse().find((line) => {
    const letters = line.replace(/[^\p{L}]/gu, '');
    const words = line.split(/\s+/).length;
    return letters.length >= 4 && words >= 2 && words <= 12 && line.length <= 120
      && letters === letters.toLocaleUpperCase();
  });
  const slashTitle = [...preamble].reverse().map((line) => ({ line, candidate: line.split(/\s*[\/|]\s*/)[0].trim() }))
    .find(({ line, candidate }) => line !== candidate && candidate.length >= 4 && candidate.length <= 100
      && candidate.split(/\s+/).length <= 12 && !/[.!?]$/.test(candidate))?.candidate;
  const first = uppercaseTitle ?? slashTitle ?? preamble[0]
    ?? lines.find((line) => !headingKind(line) && !/^#/.test(line) && !looksLikeIngredient(line));
  if (first) {
    const sentence = first.length > 140 ? first.split(/(?<=[.!?])\s+/)[0] : first;
    return cleanText(sentence.replace(/^save (?:this|for later)[:!\s-]*/i, ''), 160);
  }
  const preferred = cleanText(preferredTitle, 160)
    .replace(/\s+on Instagram.*$/i, '')
    .replace(/^Instagram\s*[:|-]\s*/i, '');
  return preferred;
}

export function parseRecipeCaption(caption, options = {}) {
  const normalized = normalizeRecipeText(caption);
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const draft = emptyDraft('url');
  draft.title = titleFromCaption(normalized, options.title);
  draft.sourceURL = options.sourceURL ?? null;
  draft.sourceName = options.sourceName ?? 'Instagram';
  draft.author = options.author ?? null;
  draft.heroImage = safeDisplayImage(options.heroImage);
  draft.servings = Number(normalized.match(/\b(?:serves?|servings?|yield)\s*[:–-]?\s*(\d+)/i)?.[1] ?? '') || null;
  draft.prepTime = parseDuration(normalized.match(/\bprep(?:\s+time)?\s*[:–-]?\s*([^\n]+)/i)?.[1]);
  draft.cookTime = parseDuration(normalized.match(/\bcook(?:\s+time)?\s*[:–-]?\s*([^\n]+)/i)?.[1]);
  draft.totalTime = parseDuration(normalized.match(/\btotal(?:\s+time)?\s*[:–-]?\s*([^\n]+)/i)?.[1])
    ?? (draft.prepTime != null && draft.cookTime != null ? draft.prepTime + draft.cookTime : null);
  draft.tags = unique([...normalized.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1].toLowerCase())).slice(0, 30);

  let mode = 'meta';
  let sawIngredientHeading = false;
  let sawInstructionHeading = false;
  let ingredientSection = null;
  let instructionSection = null;
  const descriptionLines = [];

  for (const originalLine of lines) {
    let line = originalLine.replace(/^[-–—•*]\s*/, '').trim();
    const kind = headingKind(line);
    if (kind === 'ingredients') {
      mode = 'ingredients';
      sawIngredientHeading = true;
      continue;
    }
    if (kind === 'instructions') {
      mode = 'instructions';
      sawInstructionHeading = true;
      continue;
    }
    if (!line || /^https?:\/\//i.test(line) || /^#(?:\w+#?\s*)+$/u.test(line)) continue;
    if (/^(?:serves?|servings?|yield|prep(?:\s+time)?|cook(?:\s+time)?|total(?:\s+time)?)\b/i.test(line)) continue;

    if (mode === 'meta' && looksLikeIngredient(line)) mode = 'ingredients';
    if (mode === 'ingredients' && /^\d{1,2}[.)]\s+/.test(line) && !looksLikeIngredient(line)) mode = 'instructions';

    if (mode === 'ingredients') {
      if (/^[\p{L}][\p{L} &/'’-]{1,50}:$/u.test(line) && !looksLikeIngredient(line)) {
        ingredientSection = line.replace(/:$/, '');
        continue;
      }
      if (sawIngredientHeading || looksLikeIngredient(line)) {
        if (/^(?:follow|comment|share|save|tag|enjoy|shop|link in bio|full (?:recipe|notes)|recipe (?:link|at)|more (?:details|at))\b/i.test(line)) continue;
        draft.ingredients.push(parseIngredient(line, ingredientSection));
      }
    } else if (mode === 'instructions') {
      line = line.replace(/^\d{1,2}[.)]\s*/, '').trim();
      if (/^[\p{L}][\p{L} &/'’-]{1,50}:$/u.test(line)) {
        instructionSection = line.replace(/:$/, '');
        continue;
      }
      if (!line || /^(?:follow|comment|share|save|tag|shop|link in bio|full (?:recipe|notes)|recipe (?:link|at)|more (?:details|at))\b/i.test(line)) continue;
      draft.instructions.push({
        id: id('step'),
        stepNumber: draft.instructions.length + 1,
        section: instructionSection,
        text: cleanText(line, 5_000),
        timerMinutes: parseDuration(line),
      });
    } else if (line !== draft.title && descriptionLines.length < 3) {
      descriptionLines.push(line);
    }
  }

  // Without an explicit instruction heading, accept only clearly numbered directions.
  if (!sawInstructionHeading && !draft.instructions.length) {
    const numbered = lines
      .filter((line) => /^\d{1,2}[.)]\s+/.test(line) && !looksLikeIngredient(line))
      .map((line) => line.replace(/^\d{1,2}[.)]\s*/, '').trim());
    draft.instructions = numbered.slice(0, 100).map((text, index) => ({
      id: id('step'), stepNumber: index + 1, section: null, text, timerMinutes: parseDuration(text),
    }));
  }

  // A heading is evidence that unquantified ingredient lines are intentional. Otherwise require quantities.
  if (!sawIngredientHeading) draft.ingredients = draft.ingredients.filter((ingredient) => looksLikeIngredient(ingredient.rawText));
  draft.ingredients = draft.ingredients.slice(0, 300);
  draft.instructions = draft.instructions.slice(0, 200);
  draft.description = cleanText(descriptionLines.join('\n'), 2_000);
  return draft;
}

function metadataValue(metadata, ...keys) {
  if (!metadata || typeof metadata !== 'object') return '';
  for (const key of keys) {
    if (metadata[key] != null) return firstText(metadata[key]);
    const found = Object.entries(metadata).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    if (found) return firstText(found[1]);
  }
  return '';
}

function captionFromDescription(value) {
  const description = cleanText(value, 75_000);
  const quoted = description.match(/\bon\s+[^:\n]{2,100}:\s*["“]([\s\S]*)["”]\s*\.?$/i);
  if (quoted) return cleanText(quoted[1], 75_000);
  if (!/^(?:instagram|see instagram|create an account|log in)/i.test(description)) return description;
  return '';
}

function captionFromReaderMarkdown(content, creator) {
  const lines = cleanText(content, 100_000).split('\n');
  const creatorPattern = creator ? new RegExp(`instagram\\.com/${creator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`, 'i') : /instagram\.com\/[\w.]+\/?/i;
  const start = lines.findIndex((line) => creatorPattern.test(line) && /(?:•|\b)(?:\d+\s*)?(?:s|m|h|d|w|y)\b|edited/i.test(line));
  if (start < 0) return '';
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (collected.length && /^\[[^\]]+\]\(https:\/\/(?:www\.)?instagram\.com\/[^)]+\)/i.test(trimmed)) break;
    if (trimmed) collected.push(trimmed);
    if (collected.join('\n').length >= 75_000) break;
  }
  return cleanText(collected.join('\n'), 75_000);
}

function isInstagramHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'instagram.com' || host.endsWith('.instagram.com');
}

function isLikelyRelatedUrl(url, sourceUrl) {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  if (url.href === sourceUrl.href || isInstagramHost(url.hostname)) return false;
  const host = url.hostname.toLowerCase();
  if (NON_RECIPE_HOSTS.has(host) || host === 'r.jina.ai') return false;
  if (/\.(?:jpe?g|png|gif|webp|svg|mp4|mov|m3u8|css|js|woff2?)(?:$|\?)/i.test(url.pathname)) return false;
  return true;
}

function urlsFromText(value) {
  const decoded = decodeHtmlEntities(String(value ?? ''));
  const results = [];
  const pattern = /https:\/\/[^\s<>"'\]]+/gi;
  for (const match of decoded.matchAll(pattern)) {
    let raw = match[0].replace(/[),.;!?]+$/, '');
    // Markdown URLs retain a final parenthesis only when it balances a parenthesis in the URL.
    if ((raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) raw = raw.replace(/\)+$/, '');
    try {
      const url = new URL(raw);
      if (isInstagramHost(url.hostname) && /^\/.*(?:l\.php|linkshim)/i.test(url.pathname)) {
        const destination = url.searchParams.get('u') ?? url.searchParams.get('url');
        if (destination) results.push(new URL(destination));
      } else {
        results.push(url);
      }
    } catch { /* Ignore malformed text URLs. */ }
  }
  return results;
}

function creatorFromReader(data, description, content) {
  const fromDescription = description.match(/(?:comments?\s+-|\s-\s)\s*@?([\w.]{1,30})\s+on\s+/i)?.[1];
  if (fromDescription) return fromDescription;
  const profileMatches = [...String(content ?? '').matchAll(/https:\/\/(?:www\.)?instagram\.com\/([\w.]{1,30})\/?(?:[?#)\s]|$)/gi)];
  return profileMatches.map((match) => match[1]).find((name) => !/^(?:reel|reels|p|tv|explore|accounts|stories)$/i.test(name)) ?? null;
}

export function parseInstagramReaderPayload(payload, sourceUrlValue) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  if (!data || typeof data !== 'object') throw new Error('Reader returned an invalid response.');
  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const description = metadataValue(metadata, 'og:description', 'description') || firstText(data.description);
  const content = cleanText(data.content, 100_000);
  const creator = creatorFromReader(data, description, content);
  const captionCandidates = unique([
    captionFromDescription(description),
    captionFromReaderMarkdown(content, creator),
  ]);
  const caption = captionCandidates.sort((left, right) => {
    const evidenceDifference = recipeEvidenceScore(parseRecipeCaption(right)) - recipeEvidenceScore(parseRecipeCaption(left));
    return evidenceDifference || right.length - left.length;
  })[0] ?? '';
  const title = metadataValue(metadata, 'og:title', 'title') || firstText(data.title);
  const heroImage = metadataValue(metadata, 'og:image', 'twitter:image', 'image');
  const sourceUrl = normalizeSourceUrl(sourceUrlValue);
  const sourceSegments = sourceUrl.pathname.split('/').filter(Boolean);
  const isProfilePage = sourceSegments.length === 1
    && !/^(?:reel|reels|p|tv|explore|accounts|stories)$/i.test(sourceSegments[0]);
  // Reader markdown can include commenter profiles and recommended posts. Only
  // caption URLs are eligible crawl targets for a post import. A creator profile
  // may also expose its external website only in the rendered markdown.
  const relatedText = isProfilePage ? `${caption}\n${content}` : caption;
  const relatedUrls = unique(urlsFromText(relatedText).filter((url) => isLikelyRelatedUrl(url, sourceUrl)).map((url) => url.href))
    .map((url) => new URL(url));
  return { caption, creator, title, heroImage, relatedUrls, content, metadata };
}

function extractPageLinks(html, sourceUrl) {
  const links = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let match;
  while ((match = pattern.exec(String(html ?? ''))) && links.length < 200) {
    const raw = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '');
    try {
      const url = new URL(raw, sourceUrl);
      if (isLikelyRelatedUrl(url, sourceUrl)) links.push(url);
    } catch { /* Ignore malformed page links. */ }
  }
  return unique(links.map((url) => url.href)).map((url) => new URL(url));
}

function pageTitle(html) {
  const og = String(html ?? '').match(/<meta\b[^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    ?? String(html ?? '').match(/<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:title["']/i);
  const title = og?.[1] ?? String(html ?? '').match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '';
  return cleanText(stripHtml(title), 160);
}

function publicIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || (b === 168) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6ToBigInt(address) {
  let input = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (input.includes('%')) return null;
  const ipv4Match = input.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  if (ipv4Match) {
    if (!net.isIPv4(ipv4Match[1])) return null;
    const octets = ipv4Match[1].split('.').map(Number);
    input = input.slice(0, -ipv4Match[1].length) + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function publicIpv6(address) {
  const value = ipv6ToBigInt(address);
  if (value == null || value === 0n || value === 1n) return false;
  // IPv4-compatible and IPv4-mapped forms.
  if ((value >> 32n) === 0n || (value >> 32n) === 0xffffn) {
    const ipv4 = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.');
    return publicIpv4(ipv4);
  }
  // Require globally routed 2000::/3 and exclude special/documentation/tunnel allocations.
  if ((value >> 125n) !== 1n) return false;
  const high32 = Number(value >> 96n);
  if (high32 >= 0x20010000 && high32 <= 0x200101ff) return false;
  if (high32 === 0x20010db8) return false;
  if ((value >> 112n) === 0x2002n) return false;
  return true;
}

export function isPublicIpAddress(address) {
  const family = net.isIP(String(address ?? '').replace(/^\[|\]$/g, ''));
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

export function validateUrlSyntax(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { throw new Error('URL is invalid.'); }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  if (url.port && url.port !== '443') throw new Error('Only the standard HTTPS port is allowed.');
  if (url.href.length > 4_096) throw new Error('URL is too long.');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || hostname === 'localhost'
      || /\.(?:localhost|local|internal|home|lan|test|invalid)$/.test(hostname)) {
    throw new Error('URL hostname is not public.');
  }
  if (net.isIP(hostname) && !isPublicIpAddress(hostname)) throw new Error('URL address is not public.');
  return url;
}

async function resolvePublicAddress(url, resolver = dnsLookup, timeoutMs = 5_000) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  let timer;
  let answers;
  try {
    answers = await Promise.race([
      resolver(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(answers) || !answers.length) throw new Error('URL hostname did not resolve.');
  if (answers.some((answer) => !isPublicIpAddress(answer.address))) throw new Error('URL hostname resolved to a non-public address.');
  return answers;
}

export async function safeFetchText(rawUrl, options = {}) {
  const maxBytes = Math.min(Math.max(Number(options.maxBytes ?? MAX_RESPONSE_BYTES), 1), MAX_RESPONSE_BYTES);
  const maxRedirects = Math.min(Math.max(Number(options.maxRedirects ?? MAX_REDIRECTS), 0), MAX_REDIRECTS);
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? REQUEST_TIMEOUT_MS), 1_000), REQUEST_TIMEOUT_MS);
  let current = validateUrlSyntax(rawUrl);
  const visited = new Set();

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (visited.has(current.href)) throw new Error('Redirect loop detected.');
    visited.add(current.href);
    const addresses = await resolvePublicAddress(current, options.resolver ?? dnsLookup, Math.min(timeoutMs, 5_000));
    const selected = addresses.find((answer) => answer.family === 4) ?? addresses[0];
    const isReader = current.hostname.toLowerCase() === 'r.jina.ai';
    const headers = {
      Accept: isReader ? 'application/json' : 'text/html,application/xhtml+xml,application/ld+json;q=0.9,text/plain;q=0.8',
      'Accept-Encoding': 'identity',
      DNT: '1',
      'User-Agent': USER_AGENT,
      ...(isReader ? {
        'X-Token-Budget': '12000',
        'X-Retain-Images': 'none',
        ...(process.env.JINA_API_KEY ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` } : {}),
      } : {}),
    };

    const response = await new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
      const request = https.request(current, {
        method: 'GET',
        headers,
        family: selected.family,
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        signal: controller.signal,
      }, (incoming) => {
        const chunks = [];
        let bytes = 0;
        const contentLength = Number(incoming.headers['content-length'] ?? 0);
        const encoding = String(incoming.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (contentLength > maxBytes) {
          incoming.destroy();
          clearTimeout(timer);
          reject(new Error('Response exceeded the size limit.'));
          return;
        }
        if (encoding !== 'identity') {
          incoming.destroy();
          clearTimeout(timer);
          reject(new Error('Server ignored the identity encoding safety requirement.'));
          return;
        }
        incoming.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            incoming.destroy(new Error('Response exceeded the size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        incoming.on('end', () => {
          clearTimeout(timer);
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            url: current,
          });
        });
      });
      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error.name === 'AbortError' ? new Error('Request timed out.') : error);
      });
      request.end();
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new Error(`Redirect response ${response.status} did not include a destination.`);
      if (redirect >= maxRedirects) throw new Error('Too many redirects.');
      current = validateUrlSyntax(new URL(location, current).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Remote server returned HTTP ${response.status}.`);
    return response;
  }
  throw new Error('Too many redirects.');
}

function normalizeSourceUrl(raw) {
  const url = validateUrlSyntax(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  return url;
}

function makeReaderUrl(target) {
  return new URL(`${READER_ORIGIN}${target.href}`);
}

function sourceRecord(kind, url, label) {
  return { kind, url: url.href, label: cleanText(label, 160) };
}

function completeDraft(draft) {
  return Boolean(draft?.title && draft.ingredients?.length && draft.instructions?.length);
}

function evidenceDraft(draft) {
  return Boolean(draft?.title && ((draft.ingredients?.length ?? 0) || (draft.instructions?.length ?? 0)));
}

function resultStatus(draft) {
  if (completeDraft(draft)) return 'success';
  if (evidenceDraft(draft)) return 'partial';
  return 'error';
}

function sanitizeWarnings(warnings) {
  return unique(warnings.map((warning) => cleanText(warning, 500))).slice(0, 50);
}

function userFacingFetchWarning(kind, error) {
  const suffix = /HTTP 429/.test(String(error?.message)) ? ' The public reader is rate-limited; try again later.' : '';
  if (kind === 'instagram-post') return `Could not read the public Instagram post. It may be private, unavailable, or require sign-in.${suffix}`;
  if (kind === 'creator-profile') return `Could not read the public Instagram creator profile.${suffix}`;
  return 'Could not read one related recipe page; the importer continued with the other available sources.';
}

function assertRequest(request, fallbackJobId) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be a JSON object.');
  if (request.version !== 1) throw new Error('Unsupported import request version.');
  const jobId = typeof request.jobId === 'string' ? request.jobId.trim() : '';
  if (!jobId || jobId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(jobId)) throw new Error('Request jobId is invalid.');
  if (typeof request.url !== 'string') throw new Error('Request URL is missing.');
  if (typeof request.createdAt !== 'string' || !Number.isFinite(Date.parse(request.createdAt))) throw new Error('Request createdAt is invalid.');
  return { jobId: jobId || fallbackJobId, url: normalizeSourceUrl(request.url) };
}

async function inspectRecipePage(url, context) {
  context.sourcesChecked.push(sourceRecord('recipe-page', url, `Recipe page on ${url.hostname.replace(/^www\./, '')}`));
  context.takeRequest();
  const response = await context.fetchText(url, { timeoutMs: context.remainingTime(), maxBytes: MAX_RESPONSE_BYTES });
  const finalUrl = normalizeSourceUrl(response.url ?? url);
  const schemaDraft = bestSchemaDraft(response.body, finalUrl);
  if (schemaDraft && evidenceDraft(schemaDraft)) return { draft: schemaDraft, links: [], structured: true };

  const visibleText = stripHtml(response.body);
  const textDraft = parseRecipeCaption(visibleText, {
    title: pageTitle(response.body), sourceURL: finalUrl.href, sourceName: finalUrl.hostname.replace(/^www\./, ''),
  });
  return {
    draft: evidenceDraft(textDraft) ? textDraft : null,
    links: extractPageLinks(response.body, finalUrl),
    structured: false,
  };
}

async function processInstagram(sourceUrl, context) {
  const warnings = context.warnings;
  warnings.push('Savor checked public caption and page text only; it did not transcribe or analyze the reel video or audio.');
  context.sourcesChecked.push(sourceRecord('instagram-post', sourceUrl, 'Public Instagram post'));
  let post;
  try {
    context.takeRequest();
    const response = await context.fetchText(makeReaderUrl(sourceUrl), { timeoutMs: context.remainingTime(), maxBytes: MAX_RESPONSE_BYTES });
    post = parseInstagramReaderPayload(response.body, sourceUrl);
  } catch (error) {
    warnings.push(userFacingFetchWarning('instagram-post', error));
    return { draft: null, provider: 'public-reader' };
  }

  const author = post.creator ? `@${post.creator}` : null;
  const captionDraft = parseRecipeCaption(post.caption, {
    title: post.title,
    sourceURL: sourceUrl.href,
    sourceName: 'Instagram',
    author,
    // Instagram CDN OG images are short-lived hotlinks and would make a saved
    // recipe contact Meta directly. Linked recipe pages may provide a stable image.
    heroImage: null,
  });
  let best = evidenceDraft(captionDraft) ? captionDraft : null;
  let provider = best ? 'instagram-caption' : 'public-reader';
  if (completeDraft(best)) return { draft: best, provider };

  const candidateUrls = [...post.relatedUrls];
  if (post.creator) {
    const profileUrl = normalizeSourceUrl(`https://www.instagram.com/${post.creator}/`);
    context.sourcesChecked.push(sourceRecord('creator-profile', profileUrl, `Instagram creator @${post.creator}`));
    try {
      context.takeRequest();
      const response = await context.fetchText(makeReaderUrl(profileUrl), { timeoutMs: context.remainingTime(), maxBytes: MAX_RESPONSE_BYTES });
      const profile = parseInstagramReaderPayload(response.body, profileUrl);
      candidateUrls.push(...profile.relatedUrls);
    } catch (error) {
      warnings.push(userFacingFetchWarning('creator-profile', error));
    }
  }

  const queue = unique(candidateUrls.filter((url) => isLikelyRelatedUrl(url, sourceUrl)).map((url) => url.href)).map((url) => new URL(url));
  const seen = new Set();
  let pagesChecked = 0;
  while (queue.length && pagesChecked < MAX_RELATED_PAGES) {
    const candidate = queue.shift();
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    pagesChecked += 1;
    try {
      const page = await inspectRecipePage(candidate, context);
      if (page.draft && recipeEvidenceScore(page.draft) > recipeEvidenceScore(best)) {
        best = page.draft;
        provider = 'linked-recipe';
        best.sourceURL = sourceUrl.href;
        best.sourceName = 'Instagram';
        best.author ||= author;
        best.notes = cleanText(`Recipe details: ${candidate.href}`, 2_000);
      }
      if (completeDraft(best)) break;
      for (const link of page.links) {
        if (!seen.has(link.href) && isLikelyRelatedUrl(link, candidate)) queue.push(link);
      }
    } catch (error) {
      warnings.push(userFacingFetchWarning('recipe-page', error));
    }
  }

  if (!best && post.caption) warnings.push('Public post text was found, but it did not contain identifiable ingredients or instructions.');
  else if (best && !best.ingredients.length) warnings.push('No ingredient list was found in the public sources checked.');
  else if (best && !best.instructions.length) warnings.push('No preparation steps were found in the public sources checked.');
  return { draft: best, provider };
}

export async function processImportRequest(request, options = {}) {
  const completedAt = options.now?.() ?? new Date().toISOString();
  const fallbackJobId = options.fallbackJobId ?? 'unknown';
  let jobId = typeof request?.jobId === 'string' && request.jobId.trim() ? request.jobId.trim().slice(0, 128) : fallbackJobId;
  const warnings = [];
  const sourcesChecked = [];
  const fetchText = options.fetchText ?? safeFetchText;
  const startedAt = Date.now();
  let requestCount = 0;
  const context = {
    warnings,
    sourcesChecked,
    fetchText,
    remainingTime() {
      const remaining = JOB_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining < 1_000) throw new Error('Import job reached its time limit.');
      return Math.min(REQUEST_TIMEOUT_MS, remaining);
    },
    takeRequest() {
      this.remainingTime();
      requestCount += 1;
      if (requestCount > MAX_NETWORK_REQUESTS) throw new Error('Import job reached its request limit.');
    },
  };

  try {
    const validated = assertRequest(request, fallbackJobId);
    jobId = validated.jobId;
    let imported;
    if (isInstagramHost(validated.url.hostname)) {
      imported = await processInstagram(validated.url, context);
    } else {
      const page = await inspectRecipePage(validated.url, context);
      imported = { draft: page.draft, provider: page.structured ? 'schema-org' : 'public-reader' };
      if (!page.draft) warnings.push('No Schema.org Recipe data or identifiable ingredient/instruction sections were found.');
      else if (!completeDraft(page.draft)) warnings.push('Only part of the recipe could be identified; review the imported fields before saving.');
    }
    const status = resultStatus(imported.draft);
    if (status === 'error') {
      return {
        version: 1, jobId, status, warnings: sanitizeWarnings(warnings), provider: imported.provider,
        sourcesChecked, error: 'No usable recipe details were found in the public sources checked.', completedAt,
      };
    }
    return {
      version: 1, jobId, status, draft: imported.draft, warnings: sanitizeWarnings(warnings),
      provider: imported.provider, sourcesChecked, completedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown importer error.';
    return {
      version: 1, jobId, status: 'error', warnings: sanitizeWarnings(warnings), provider: 'public-reader',
      sourcesChecked, error: cleanText(message, 500), completedAt,
    };
  }
}

async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, filePath);
}

function safeFallbackJobId(filename) {
  const stem = path.basename(filename, '.json').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return stem || `invalid_${randomUUID()}`;
}

export async function processPendingRequests(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const requestDirectory = path.join(root, REQUEST_DIRECTORY);
  const resultDirectory = path.join(root, RESULT_DIRECTORY);
  const maxJobs = Math.min(Math.max(Number(options.maxJobs ?? MAX_JOBS_DEFAULT), 1), 100);
  let entries;
  try { entries = await fs.readdir(requestDirectory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return { processed: 0, success: 0, partial: 0, failed: 0, results: [] };
    throw error;
  }

  const pending = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const resultPath = path.join(resultDirectory, entry.name);
    if (!(await pathExists(resultPath))) pending.push({ name: entry.name, resultPath });
    if (pending.length >= maxJobs) break;
  }

  const summary = { processed: 0, success: 0, partial: 0, failed: 0, results: [] };
  for (const item of pending) {
    const requestPath = path.join(requestDirectory, item.name);
    const fallbackJobId = safeFallbackJobId(item.name);
    let request;
    let result;
    try {
      const stat = await fs.stat(requestPath);
      if (stat.size > MAX_REQUEST_FILE_BYTES) throw new Error('Import request file exceeds the size limit.');
      request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
      result = await processImportRequest(request, {
        fallbackJobId,
        fetchText: options.fetchText,
        now: options.now,
      });
    } catch (error) {
      result = {
        version: 1,
        jobId: typeof request?.jobId === 'string' ? request.jobId.slice(0, 128) : fallbackJobId,
        status: 'error',
        warnings: [],
        provider: 'public-reader',
        sourcesChecked: [],
        error: cleanText(error instanceof Error ? error.message : 'Invalid import request.', 500),
        completedAt: options.now?.() ?? new Date().toISOString(),
      };
    }
    await writeJsonAtomic(item.resultPath, result);
    summary.processed += 1;
    summary.results.push(path.relative(root, item.resultPath).split(path.sep).join('/'));
    if (result.status === 'success') summary.success += 1;
    else if (result.status === 'partial') summary.partial += 1;
    else summary.failed += 1;
  }
  return summary;
}

function parseArguments(argv) {
  const options = { root: process.cwd(), maxJobs: MAX_JOBS_DEFAULT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--max-jobs') options.maxJobs = Number(argv[++index]);
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.root) throw new Error('--root requires a directory.');
  if (!Number.isInteger(options.maxJobs) || options.maxJobs < 1 || options.maxJobs > 100) throw new Error('--max-jobs must be an integer from 1 to 100.');
  return options;
}

function writeActionOutputs(summary) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return Promise.resolve();
  const lines = [
    `processed=${summary.processed}`,
    `success=${summary.success}`,
    `partial=${summary.partial}`,
    `failed=${summary.failed}`,
    `results=${JSON.stringify(summary.results)}`,
  ];
  return fs.appendFile(outputFile, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/process-recipe-imports.mjs [--root PATH] [--max-jobs COUNT]');
    return;
  }
  const summary = await processPendingRequests(options);
  await writeActionOutputs(summary);
  console.log(JSON.stringify(summary));
  if (summary.failed) process.exitCode = 0; // Error results are expected data, not an Action crash.
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

export interface RecipeSourceUrl {
  href: string;
  kind: 'instagram' | 'web';
  sourceName: string;
}

const FRIENDLY_SOURCE_NAMES: Array<[RegExp, string]> = [
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)cooking\.nytimes\.com$/, 'NYT Cooking'],
  [/(^|\.)nytimes\.com$/, 'The New York Times'],
  [/(^|\.)bonappetit\.com$/, 'Bon Appétit'],
  [/(^|\.)seriouseats\.com$/, 'Serious Eats'],
  [/(^|\.)allrecipes\.com$/, 'Allrecipes'],
  [/(^|\.)foodnetwork\.com$/, 'Food Network'],
  [/(^|\.)bbcgoodfood\.com$/, 'BBC Good Food'],
  [/(^|\.)epicurious\.com$/, 'Epicurious'],
  [/(^|\.)food52\.com$/, 'Food52'],
  [/(^|\.)kingarthurbaking\.com$/, 'King Arthur Baking'],
  [/(^|\.)simplyrecipes\.com$/, 'Simply Recipes'],
  [/(^|\.)smittenkitchen\.com$/, 'Smitten Kitchen'],
  [/(^|\.)halfbakedharvest\.com$/, 'Half Baked Harvest'],
  [/(^|\.)budgetbytes\.com$/, 'Budget Bytes'],
  [/(^|\.)pinchofyum\.com$/, 'Pinch of Yum'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
  [/(^|\.)pinterest\.com$/, 'Pinterest'],
];

// People paste links the way their phone hands them over: sometimes without a
// scheme, sometimes as http://. Both are repaired before the URL is judged.
function normalizeLinkText(value: string): string {
  const trimmed = value.trim().replace(/^<|>$/g, '');
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://');
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function sourceNameForHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return FRIENDLY_SOURCE_NAMES.find(([pattern]) => pattern.test(host))?.[1] ?? host.replace(/^www\./, '');
}

export function parseRecipeSourceUrl(value: string): RecipeSourceUrl | null {
  try {
    const source = new URL(normalizeLinkText(value));
    if (source.protocol !== 'https:' || source.username || source.password) return null;
    const hostname = source.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname.includes('.') || hostname === 'localhost') return null;
    const isInstagram = hostname === 'instagram.com' || hostname.endsWith('.instagram.com');
    return {
      href: source.toString(),
      kind: isInstagram ? 'instagram' : 'web',
      sourceName: sourceNameForHost(hostname),
    };
  } catch {
    return null;
  }
}

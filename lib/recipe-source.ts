export interface RecipeSourceUrl {
  href: string;
  kind: 'instagram' | 'web';
  sourceName: string;
}

export function parseRecipeSourceUrl(value: string): RecipeSourceUrl | null {
  try {
    const source = new URL(value.trim());
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) return null;
    const hostname = source.hostname.toLowerCase().replace(/\.$/, '');
    const isInstagram = hostname === 'instagram.com' || hostname.endsWith('.instagram.com');
    return {
      href: source.toString(),
      kind: isInstagram ? 'instagram' : 'web',
      sourceName: isInstagram ? 'Instagram' : hostname.replace(/^www\./, ''),
    };
  } catch {
    return null;
  }
}

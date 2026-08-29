// Shared rules for the image references stored in synced household data. Kept
// dependency-free so both GitHub sync and the domain tests can use them.

export function isHttpUrl(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

export function isImageReference(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 1_300_000) return false;
  // Builds before this fix stored "" instead of null for a recipe with no
  // photo, which then failed validation on every later read. Accept it so an
  // affected file still loads; normalizeImageReference heals it on the way back.
  if (value === '') return true;
  if (/^\.\/recipes\/[A-Za-z0-9_.-]+$/.test(value)) return true;
  if (/^github-media:savor\/v1\/media\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(value)) return true;
  if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return true;
  return isHttpUrl(value);
}

// "No image" has exactly one representation on disk: null.
export function normalizeImageReference(value: string | null | undefined): string | null {
  return value ? value : null;
}

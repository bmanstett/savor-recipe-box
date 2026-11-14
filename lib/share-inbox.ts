import { readSharedRecipeLink, shareShortcutPrefix } from './share-intake.ts';

const KEY = 'savor.pending-shares.v1';
const MAX_LINKS = 20;
type InboxStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Tab-local links only. No recipe data or credentials go into this inbox.
// Persist before cleaning the address bar, and keep each link until its review
// is saved or explicitly closed. Storage-denied browsers still work in memory.
export function createShareInbox(storage: InboxStorage | null, appUrl: string) {
  const prefix = shareShortcutPrefix(appUrl);
  const validate = (value: unknown) => typeof value === 'string' && value.length <= 8_000 && prefix
    ? readSharedRecipeLink(prefix + encodeURIComponent(value)).url : null;
  let pending: string[] = [];
  try {
    const raw = storage?.getItem(KEY);
    const saved: unknown = raw && raw.length <= 160_000 ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) pending = [...new Set(saved.slice(0, MAX_LINKS).map(validate).filter((url): url is string => Boolean(url)))];
  } catch { /* An empty inbox is safe when browser storage is unavailable. */ }
  const persist = () => {
    try {
      if (pending.length) storage?.setItem(KEY, JSON.stringify(pending));
      else storage?.removeItem(KEY);
    } catch { /* Keep the in-memory queue usable. */ }
  };
  return {
    get urls() { return [...pending]; },
    enqueue(value: string): 'added' | 'duplicate' | 'full' | 'invalid' {
      const url = validate(value);
      if (!url) return 'invalid';
      if (pending.includes(url)) return 'duplicate';
      if (pending.length >= MAX_LINKS) return 'full';
      pending.push(url);
      persist();
      return 'added';
    },
    complete(url: string) {
      pending = pending.filter((item) => item !== url);
      persist();
    },
  };
}

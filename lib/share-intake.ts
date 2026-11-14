export interface SharedRecipeLink {
  url: string | null;
  hadSharePayload: boolean;
  cleanedHref: string;
}

const SHARE_KEYS = new Set(['url', 'text', 'title']);
const WRAPPERS = [['<', '>'], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['(', ')'], ['[', ']']];

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const address = host.slice(1, -1);
    // Accept global IPv6 unicast only. IPv4-mapped and local/tunnel addresses
    // are deliberately excluded; DNS resolution is checked again by the server.
    return /^[23][\da-f]{3}:/.test(address)
      && !/^2001:(?::|(?:[\da-f]{1,2}|1[\da-f]{2}|db8):)/.test(address)
      && !/^2002:/.test(address);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
      && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      && !(a === 203 && b === 0 && c === 113);
  }
  return host.length <= 253 && host.includes('.')
    && !/(?:^|\.)(?:localhost|local|localdomain|internal|home|lan|test|invalid|example|onion)$/.test(host)
    && host.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label));
}

function appPath(url: URL): string {
  return url.pathname.replace(/\/index\.html$/i, '/').replace(/\/+$/, '') || '/';
}

function isAppLink(target: URL, app: URL): boolean {
  if (target.hostname.toLowerCase().replace(/\.$/, '') !== app.hostname.toLowerCase().replace(/\.$/, '')
    || target.port !== app.port) return false;
  const base = appPath(app);
  const candidate = appPath(target);
  return base === '/' || candidate === base || candidate.startsWith(`${base}/`);
}

function publicRecipeUrl(value: string, app: URL, allowBare: boolean): string | null {
  let input = value.trim();
  if (!input || input.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(input)) return null;
  if (!/^https?:\/\//i.test(input)) {
    if (!allowBare) return null;
    if (input.startsWith('//')) input = `https:${input}`;
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(input)
        && !/^[^/?#:]+\.[^/?#:]+:\d+(?:[/?#]|$)/.test(input)) return null;
      input = `https://${input}`;
    }
  }
  try {
    const target = new URL(input);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    target.protocol = 'https:';
    if (target.port && target.port !== '443') return null;
    if (!isPublicHost(target.hostname) || isAppLink(target, app)) return null;
    return target.href.length <= 4096 ? target.href : null;
  } catch { return null; }
}

function unwrap(value: string): string {
  let result = value.trim();
  for (let count = 0; count < 3; count += 1) {
    const pair = WRAPPERS.find(([start, end]) => result.startsWith(start) && result.endsWith(end));
    if (!pair) break;
    result = result.slice(pair[0].length, -pair[1].length).trim();
  }
  return result;
}

function proseUrl(value: string): string {
  let candidate = value;
  let previous = '';
  while (candidate !== previous) {
    previous = candidate;
    candidate = candidate.replace(/[.,;:!?"'‘’“”]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      const count = (character: string) => candidate.split(character).length - 1;
      while (candidate.endsWith(close) && count(close) > count(open)) candidate = candidate.slice(0, -1);
    }
  }
  return candidate;
}

function findLink(value: string, app: URL, allowBare: boolean): string | null {
  const trimmed = value.trim();
  const unwrapped = unwrap(trimmed);
  if (/^(?:javascript|data|file|ftp|blob|mailto|tel|vbscript|intent|about):/i.test(unwrapped)) return null;
  // A direct URL can legally end in punctuation or balanced parentheses. Only
  // prose-extracted links have surrounding sentence punctuation removed.
  const direct = publicRecipeUrl(trimmed, app, allowBare);
  if (direct) return direct;
  if (unwrapped !== trimmed) {
    const wrapped = publicRecipeUrl(unwrapped, app, allowBare);
    if (wrapped) return wrapped;
  }
  for (const match of trimmed.matchAll(/https?:\/\/[^\s<>“”"]+/gi)) {
    const extracted = publicRecipeUrl(proseUrl(match[0]), app, false);
    if (extracted) return extracted;
  }
  return null;
}

function payloadValues(payload: string): Array<{ value: string; allowBare: boolean }> {
  const params = new URLSearchParams(payload);
  // URL fields sometimes arrive without form-encoding literal plus signs.
  // Text/title still use ordinary HTML form decoding for their spaces.
  const urlParams = new URLSearchParams(payload.replace(/\+/g, '%2B'));
  return [
    ...urlParams.getAll('url').map((value) => ({ value, allowBare: true })),
    ...params.getAll('text').map((value) => ({ value, allowBare: false })),
    ...params.getAll('title').map((value) => ({ value, allowBare: false })),
  ];
}

export function readSharedRecipeLink(locationHref: string): SharedRecipeLink {
  let location: URL;
  try { location = new URL(locationHref); }
  catch { return { url: null, hadSharePayload: false, cleanedHref: locationHref }; }
  const queryPayload = [...SHARE_KEYS].some((key) => location.searchParams.has(key));
  const fragmentPayload = location.hash.startsWith('#share?');
  const hadSharePayload = queryPayload || fragmentPayload;
  if (!hadSharePayload) return { url: null, hadSharePayload: false, cleanedHref: location.href };

  const payload = fragmentPayload ? location.hash.slice('#share?'.length) : location.search.slice(1);
  let url: string | null = null;
  for (const candidate of payloadValues(payload)) {
    url = findLink(candidate.value, location, candidate.allowBare);
    if (url) break;
  }
  // Keep unrelated query values byte-for-byte (including + and percent escapes).
  const remaining = location.search.slice(1).split('&').filter((part) => {
    const key = new URLSearchParams(part).keys().next().value;
    return key === undefined || !SHARE_KEYS.has(key);
  });
  location.search = remaining.join('&');
  if (fragmentPayload) location.hash = '';
  return { url, hadSharePayload, cleanedHref: location.href };
}

export function shareShortcutPrefix(appUrl: string): string {
  try {
    const target = new URL(appUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return '';
    const localhost = target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '[::1]';
    if (!localhost && !isPublicHost(target.hostname)) return '';
    if (!localhost) target.protocol = 'https:';
    target.search = '';
    target.hash = '#share?url=';
    return target.href;
  } catch { return ''; }
}

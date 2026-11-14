// Shared by HTML imports and Claude's rendered public-page evidence. An access
// gate is a reason to preserve the source link, never to infer a missing recipe.
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const NON_VISIBLE_ELEMENTS = new Set(['script', 'style', 'template', 'noscript', 'head']);

function decodeText(value) {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (match, decimal, hex, name) => {
    if (decimal || hex) {
      const code = Number.parseInt(decimal || hex, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ({ nbsp: ' ', amp: '&', quot: '"', apos: "'", rsquo: "'", lsquo: "'" })[name.toLowerCase()] ?? match;
  });
}

function attributes(tag) {
  const result = {};
  const body = tag.replace(/^<\/?[\w:-]+/, '').replace(/\/?\s*>$/, '');
  for (const match of body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    result[match[1].toLowerCase()] = decodeText(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function hiddenElement(name, attrs) {
  return NON_VISIBLE_ELEMENTS.has(name) || Object.hasOwn(attrs, 'hidden')
    || attrs['aria-hidden']?.toLowerCase() === 'true'
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test(attrs.style ?? '');
}

function explicitGate(attrs) {
  return (attrs.class ?? '').split(/\s+/).some((name) => name.toLowerCase() === 'paywall')
    || ['data-testid', 'data-component-name', 'aria-label'].some((name) => attrs[name]?.trim().toLowerCase() === 'paywall');
}

function visibleEvidence(input) {
  // Walk tags instead of searching raw HTML: hidden templates and scripts often
  // contain paywall components even when the visitor can read the entire page.
  const stack = [];
  const text = [];
  const tokens = input.matchAll(/<!--[\s\S]*?(?:-->|$)|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</gi);
  for (const match of tokens) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    const tag = token.match(/^<(\/?)([a-z][\w:-]*)\b/i);
    // HTML treats script/style bodies as raw text. A string such as </section>
    // inside one must not pop its actual ancestor and expose a hidden template.
    const rawElement = stack.at(-1)?.name;
    if ((rawElement === 'script' || rawElement === 'style') && !(tag?.[1] && tag[2].toLowerCase() === rawElement)) continue;
    if (!tag) {
      if (!stack.some((item) => item.hidden)) text.push(token);
      continue;
    }
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      const index = stack.findLastIndex((item) => item.name === name);
      if (index >= 0) stack.length = index;
      text.push('\n');
      continue;
    }
    const attrs = attributes(token);
    const hidden = hiddenElement(name, attrs);
    const visible = !hidden && !stack.some((item) => item.hidden);
    if (visible && explicitGate(attrs)) return { gate: true, text: '' };
    if (visible) text.push('\n');
    if (!VOID_ELEMENTS.has(name) && !/\/\s*>$/.test(token)) stack.push({ name, hidden });
  }
  return { gate: false, text: decodeText(text.join(' ')) };
}

export function hasRecipeAccessGate(textOrHtml) {
  if (typeof textOrHtml !== 'string' || !textOrHtml.trim()) return false;
  const evidence = visibleEvidence(textOrHtml);
  if (evidence.gate) return true;
  const text = evidence.text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (/\b(?:this|the) (?:post|article|recipe|content) is (?:only )?(?:(?:available|reserved) )?(?:for|to) (?:our )?(?:(?:paid|premium|paying) )?(?:subscribers|members)\b/i.test(text)) return true;
  if (/\b(?:subscribe|sign in|sign up|log in) to (?:continue reading|keep reading|(?:read|view|access|unlock) (?:the |this )?(?:full |rest of (?:the |this )?)?(?:post|article|recipe|content))\b/i.test(text)) return true;
  // Substack's complimentary-post offer still hides the recipe until the reader
  // claims access. A normal newsletter subscription footer is not sufficient.
  if (/\bcontinue reading this (?:post|article) for free\b.{0,600}\b(?:claim my free (?:post|article)|purchase a paid subscription|subscribe)\b/i.test(text)) return true;
  return false;
}

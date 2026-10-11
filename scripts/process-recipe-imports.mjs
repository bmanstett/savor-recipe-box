#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const IMPORTER_VERSION = '2';

const REQUEST_DIRECTORY = path.join('savor', 'v1', 'imports', 'requests');
const RESULT_DIRECTORY = path.join('savor', 'v1', 'imports', 'results');
const MAX_REQUEST_FILE_BYTES = 64 * 1024;
/**
 * Cap on both the raw bytes read from the socket and the decompressed body
 * handed to the parsers. A larger page is not rejected: reading stops at the
 * cap and whatever arrived is parsed (JSON-LD sits in the first few hundred KB).
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The public reader returns rendered text only, so it gets a smaller cap. */
export const READER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Hero images above this size stay hotlinks instead of being embedded as data URLs. */
export const MAX_HERO_IMAGE_BYTES = 600 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 20_000;
const JOB_TIMEOUT_MS = 75_000;
const MAX_RELATED_PAGES = 5;
const MAX_NETWORK_REQUESTS = 12;
const MAX_JOBS_DEFAULT = 10;
/** Wall-clock budget for one run; pending requests past it are left for the next run. */
export const DEFAULT_MAX_RUN_MS = 15 * 60_000;
const CHALLENGE_BODY_LIMIT = 15 * 1024;
const MIN_RENDERED_TEXT_CHARS = 400;
const MAX_NOTES_CHARS = 2_000;
const READER_ORIGIN = 'https://r.jina.ai/';

// Limits the app enforces on a result before it opens the review screen
// (lib/github-import-queue.ts). Everything the importer emits is clamped to them.
export const CLIENT_LIMITS = Object.freeze({
  title: 1_000, description: 20_000, notes: 50_000, shortText: 500, rawText: 2_000, instruction: 10_000,
  unit: 100, ingredients: 500, instructions: 500, links: 20, warnings: 50, warning: 500, listItems: 100,
});

export const HONEST_USER_AGENT = 'SavorRecipeImporter/1.0 (+https://github.com/bmanstett/savor-recipe-box)';
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const REQUEST_PROFILES = {
  honest: {
    Accept: HTML_ACCEPT,
    'Accept-Encoding': 'gzip, br, deflate',
    'Accept-Language': 'en-US,en;q=0.9',
    DNT: '1',
    'User-Agent': HONEST_USER_AGENT,
  },
  browser: {
    Accept: HTML_ACCEPT,
    'Accept-Encoding': 'gzip, br, deflate',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    DNT: '1',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': BROWSER_USER_AGENT,
  },
  reader: {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, br, deflate',
    DNT: '1',
    'User-Agent': HONEST_USER_AGENT,
    'X-Retain-Images': 'none',
    'X-Token-Budget': '12000',
  },
  image: {
    Accept: 'image/webp,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
    'Accept-Encoding': 'identity',
    DNT: '1',
    'User-Agent': HONEST_USER_AGENT,
  },
};

const RETRYABLE_STATUSES = new Set([403, 406, 429, 503]);

// Interstitial wording that identifies a bot challenge wherever it appears in a
// small page. "captcha" on its own is too common (comment forms embed
// reCAPTCHA), so it only counts in the <title> or as a challenge container.
const CHALLENGE_MARKERS = [
  /just a moment/i,
  /access denied/i,
  /attention required/i,
  /pardon our interruption/i,
  /please enable javascript/i,
  /enable javascript and cookies/i,
  /verify (?:that )?you are (?:a )?human/i,
  /are you a robot/i,
  /request unsuccessful\. incapsula/i,
];
const CHALLENGE_TITLE_MARKERS = [
  ...CHALLENGE_MARKERS,
  /(?:^|\W)(?:re|h)?captcha(?:\W|$)/i,
  /security check|checking your browser|robot or human|one more step/i,
];
// Markup only a challenge page carries. Cloudflare also injects
// /cdn-cgi/challenge-platform scripts into ordinary pages, so that path alone is
// not evidence.
const CHALLENGE_CONTAINER = /cf-chl-widget|cf_chl_opt|__cf_chl_rt_tk|cf-browser-verification|id=["']challenge-(?:form|running|stage)|px-captcha|sec-cpt-if|_Incapsula_Resource|distil_r_captcha|awsWafCookieDomainList|captcha-delivery\.com/i;

// Query parameters that only carry campaign or share tracking. Everything else
// may be meaningful (pagination, print views, recipe ids), so keep it. The app
// strips a subset of these before queueing a request; whatever it sent is
// recorded verbatim in sourcesChecked (see processImportRequest), so the two
// lists do not have to match exactly.
const TRACKING_PARAMETERS = new Set([
  'igsh', 'igshid', 'fbclid', 'gclid', 'dclid', 'msclkid', 'twclid', 'ttclid', 'yclid',
  'mc_cid', 'mc_eid', 'smid', 'sgrp', 'ref', 'ref_src', 'ref_url',
]);
// "s" and "si" are share identifiers only on these hosts.
const HOST_TRACKING_PARAMETERS = [
  [/(?:^|\.)(?:youtube\.com|youtu\.be)$/i, new Set(['si', 'feature'])],
  [/(?:^|\.)(?:twitter\.com|x\.com)$/i, new Set(['s', 't'])],
  [/(?:^|\.)instagram\.com$/i, new Set(['ig_rid', 'img_index'])],
];

// Social networks and generic video, audio and app hosts. A creator's bio often
// links to them, but none of them serves a recipe page worth a crawl request.
// Matching is by domain suffix (m.youtube.com, player.vimeo.com, *.muse.ai).
const NON_RECIPE_DOMAINS = [
  'facebook.com', 'threads.net', 'tiktok.com', 'twitter.com', 'x.com', 'pinterest.com', 'snapchat.com',
  'youtube.com', 'youtu.be', 'vimeo.com', 'muse.ai', 'dailymotion.com', 'twitch.tv',
  'spotify.com', 'podcasts.apple.com', 'music.apple.com', 'soundcloud.com', 'anchor.fm',
  'patreon.com', 'cameo.com', 'discord.gg', 'discord.com', 'reddit.com', 'tumblr.com',
];

// Meta boilerplate and app-store links that appear on every Instagram page.
// Matching is by domain suffix so subdomains such as help.instagram.com are
// covered without listing each one.
const CRAWL_BLOCKLIST_DOMAINS = [
  'meta.com', 'about.meta.com', 'meta.ai', 'facebook.com', 'fb.com', 'fb.me',
  'developers.facebook.com', 'threads.net', 'threads.com', 'instagram.com',
  'help.instagram.com', 'privacycenter.instagram.com', 'cdninstagram.com',
  'whatsapp.com', 'messenger.com', 'oculus.com', 'play.google.com',
  'apps.apple.com', 'itunes.apple.com', 'apple.com', 'microsoft.com',
  'google.com', 'r.jina.ai', 'jina.ai',
];

// Jina Reader refuses People Inc. properties (HTTP 451); never route them there.
const READER_EXCLUDED_DOMAINS = [
  'allrecipes.com', 'seriouseats.com', 'simplyrecipes.com', 'foodandwine.com',
  'eatingwell.com', 'thespruceeats.com', 'thespruce.com', 'marthastewart.com',
  'bhg.com', 'realsimple.com', 'southernliving.com', 'myrecipes.com', 'people.com',
];

// Link-in-bio landing pages. They are not recipe pages themselves, but they are
// the usual route from a creator profile to the page that holds the recipe, so
// the crawler visits them early and follows their outbound links.
const LINK_HUB_HOSTS = new Set([
  'linktr.ee', 'linktree.com',
  'beacons.ai', 'beacons.page',
  'stan.store',
  'lnk.bio', 'linkin.bio', 'bio.site', 'bio.fm',
  'campsite.bio', 'tap.bio',
  'milkshake.app', 'msha.ke',
  'solo.to', 'liinks.co', 'hoo.be', 'komi.io',
  'allmylinks.com', 'direct.me', 'snipfeed.co', 'flow.page',
]);

const NON_RECIPE_PATH_PATTERN = /\/(?:about|contact|privacy|terms|press|careers|account|login|signup|cart|checkout|subscribe|newsletter|merch|podcast)(?:\/|$)/i;

const TITLE_STOPWORDS = new Set([
  'and', 'the', 'with', 'for', 'from', 'this', 'that', 'these', 'your', 'you',
  'recipe', 'recipes', 'easy', 'best', 'quick', 'simple', 'homemade', 'how', 'make',
]);

function hostMatchesDomain(hostname, domain) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

function hostInDomainList(hostname, domains) {
  return domains.some((domain) => hostMatchesDomain(hostname, domain));
}

function isLinkHubUrl(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return LINK_HUB_HOSTS.has(host) || host.endsWith('.carrd.co');
}

function isInstagramHost(hostname) {
  return hostMatchesDomain(hostname, 'instagram.com');
}

function isReaderExcluded(url) {
  return hostInDomainList(url.hostname, READER_EXCLUDED_DOMAINS);
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

// The complete HTML 4 Latin-1 entity set (U+00A0–U+00FF, in code-point order)
// plus the punctuation, fraction and typographic names recipe pages use.
const LATIN1_ENTITY_NAMES = [
  'nbsp', 'iexcl', 'cent', 'pound', 'curren', 'yen', 'brvbar', 'sect', 'uml', 'copy', 'ordf', 'laquo', 'not', 'shy', 'reg', 'macr',
  'deg', 'plusmn', 'sup2', 'sup3', 'acute', 'micro', 'para', 'middot', 'cedil', 'sup1', 'ordm', 'raquo', 'frac14', 'frac12', 'frac34', 'iquest',
  'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil', 'Egrave', 'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml',
  'ETH', 'Ntilde', 'Ograve', 'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times', 'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml', 'Yacute', 'THORN', 'szlig',
  'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig', 'ccedil', 'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute', 'icirc', 'iuml',
  'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml', 'divide', 'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml',
];
const COMMON_HTML_ENTITIES = {
  ...Object.fromEntries(LATIN1_ENTITY_NAMES.map((name, index) => [name, String.fromCodePoint(0xa0 + index)])),
  amp: '&', apos: "'", gt: '>', lt: '<', quot: '"',
  hellip: '…', ldquo: '“', lsquo: '‘', rdquo: '”', rsquo: '’', sbquo: '‚', bdquo: '„', lsaquo: '‹', rsaquo: '›',
  mdash: '—', ndash: '–', bull: '•', prime: '′', Prime: '″', trade: '™', euro: '€', dagger: '†', permil: '‰',
  frac13: '⅓', frac23: '⅔', frac15: '⅕', frac25: '⅖', frac35: '⅗', frac45: '⅘', frac16: '⅙', frac56: '⅚',
  frac18: '⅛', frac38: '⅜', frac58: '⅝', frac78: '⅞', minus: '−', ne: '≠', le: '≤', ge: '≥', asymp: '≈', infin: '∞',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '', zwnj: '', lrm: '', rlm: '',
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueBy(values, keyOf) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try { return String.fromCodePoint(codePoint); } catch { return match; }
      }
      return match;
    }
    // Entity names are case-sensitive (&Eacute; vs &eacute;); fall back to the
    // lowercase name for sloppy markup such as &NBSP;.
    return COMMON_HTML_ENTITIES[entity] ?? COMMON_HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function cleanText(value, maxLength = 10_000) {
  return decodeHtmlEntities(String(value ?? ''))
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
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

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// HTML scanning. A small tokenizer that understands quoted attribute values,
// comments and raw-text elements, used for visible text, microdata and
// recipe-plugin markup. It is not a full HTML parser, but it never breaks on a
// ">" inside an attribute value the way a regex does.
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'xmp', 'noscript', 'iframe']);
const DROPPED_ELEMENTS = new Set([
  'head', 'script', 'style', 'noscript', 'iframe', 'svg', 'template', 'nav', 'header',
  'footer', 'form', 'button', 'aside', 'select', 'canvas', 'object', 'video', 'audio',
]);
// Page chrome identified by id or class: comment threads, sidebars, "related
// posts" rails, newsletter and share widgets, cookie banners, ads. Matching is
// deliberately narrow because the same words occur on content wrappers:
// WordPress post_class() emits "tag-cookies"/"category-comments" on the post
// <div>, Genesis wraps the page in "content-sidebar-wrap", and dropping either
// erases the whole recipe before the text parser runs.
// Substrings that only ever name chrome, matched anywhere in the id/class.
const BOILERPLATE_ANYWHERE = /newsletter|breadcrumb|advert|adsbygoogle|consent|gdpr|cookie[-_]?(?:notice|banner|bar|law|policy|popup|modal|message|wall|alert|disclaimer|notification)|comments?[-_]?(?:list|form|respond|reply|area|section|thread|box|body|holder|wrap|container|title|header)|wp-block-(?:comments|latest-comments|post-comments)|related[-_]?(?:posts?|recipes?|articles?|content|rail|items|links|stories|products|entries|reading)|yarpp|share[-_]?(?:buttons?|bar|icons?|links?|box|tools|count|this|container|wrap|row|list|menu)|social[-_]?shar|sharedaddy|shareaholic|addtoany|a2a_/i;
// Words that also appear inside content wrappers, so they only count as a whole class token (or the id).
const BOILERPLATE_TOKEN = /^(?:comments?|commentlist|respond|sidebar|sidebar[-_](?!toggle|open|close|button)[\w-]+|(?:primary|secondary|site|main|blog|post|page|single|right|left|global|widget|sticky|recipe|desktop|mobile|article|entry)[-_]sidebar|widget-area|share|sharing|promos?|promos?[-_][\w-]+|[\w-]+[-_]promo|ads?|ad[-_][\w-]+|(?:wp|post|entry|article|recipe|site|blog|page|single)[-_]comments?|(?:post|entry|article|recipe|page|jp|wprm)[-_]shar(?:e|ing)(?:[-_][\w-]+)?)$/i;
// Post, entry and recipe wrappers are never dropped by class, whatever else they carry.
const CONTENT_MARKER = /^(?:post|hentry|type-post|type-recipe|entry|entry-content|post-content|article|article-content|content|site-content|main-content|page-content|recipe|recipe-content|wprm-recipe|wprm-recipe-container|tasty-recipes|mv-create)$|^post-\d+$/i;
const CONTENT_CONTAINERS = new Set(['html', 'body', 'main', 'article']);
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'label', 'legend',
  'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead',
  'tfoot', 'tr', 'ul', 'br', 'title', 'caption',
]);

function isNameStart(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(code) {
  return isNameStart(code) || (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95 || code === 46;
}

function isSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** Parses the tag starting at html[index] === '<'. Returns null when it is literal text. */
function readTag(html, index) {
  const length = html.length;
  if (html.startsWith('<!--', index)) {
    const close = html.indexOf('-->', index + 4);
    return { kind: 'comment', start: index, end: close < 0 ? length : close + 3 };
  }
  const second = html.charCodeAt(index + 1);
  if (second === 33 || second === 63) { // "<!" doctype / "<?" processing instruction
    const close = html.indexOf('>', index + 2);
    return { kind: 'directive', start: index, end: close < 0 ? length : close + 1 };
  }
  let cursor = index + 1;
  let closing = false;
  if (html.charCodeAt(cursor) === 47) { closing = true; cursor += 1; }
  if (!isNameStart(html.charCodeAt(cursor))) return null;
  const nameStart = cursor;
  while (cursor < length && isNameChar(html.charCodeAt(cursor))) cursor += 1;
  const name = html.slice(nameStart, cursor).toLowerCase();
  const attrs = {};
  let selfClosing = false;
  while (cursor < length) {
    while (cursor < length && isSpace(html.charCodeAt(cursor))) cursor += 1;
    const code = html.charCodeAt(cursor);
    if (code === 62) { cursor += 1; break; } // ">"
    if (code === 47) { // "/"
      cursor += 1;
      if (html.charCodeAt(cursor) === 62) { selfClosing = true; cursor += 1; break; }
      continue;
    }
    const attrStart = cursor;
    while (cursor < length) {
      const c = html.charCodeAt(cursor);
      if (isSpace(c) || c === 61 || c === 62 || c === 47) break;
      cursor += 1;
    }
    const attrName = html.slice(attrStart, cursor).toLowerCase();
    if (!attrName) { cursor += 1; continue; }
    let value = '';
    let probe = cursor;
    while (probe < length && isSpace(html.charCodeAt(probe))) probe += 1;
    if (html.charCodeAt(probe) === 61) { // "="
      probe += 1;
      while (probe < length && isSpace(html.charCodeAt(probe))) probe += 1;
      const quote = html.charCodeAt(probe);
      if (quote === 34 || quote === 39) {
        const close = html.indexOf(String.fromCharCode(quote), probe + 1);
        value = html.slice(probe + 1, close < 0 ? length : close);
        cursor = close < 0 ? length : close + 1;
      } else {
        const valueStart = probe;
        while (probe < length && !isSpace(html.charCodeAt(probe)) && html.charCodeAt(probe) !== 62) probe += 1;
        value = html.slice(valueStart, probe);
        cursor = probe;
      }
    }
    if (!(attrName in attrs)) attrs[attrName] = decodeHtmlEntities(value);
  }
  return { kind: 'tag', name, attrs, closing, selfClosing, start: index, end: cursor };
}

/** Index of the "</name" that ends a raw-text element, or html.length. */
function rawTextEnd(html, name, from) {
  const pattern = new RegExp(`</${name}\\s*>`, 'ig');
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  return match ? { contentEnd: match.index, end: match.index + match[0].length } : { contentEnd: html.length, end: html.length };
}

function classList(element) {
  return String(element.attrs.class ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

function hasClass(element, className) {
  return classList(element).includes(className.toLowerCase());
}

/**
 * Builds a flat list of elements with their content ranges so callers can read
 * inner HTML by class or itemprop without a DOM. Unclosed elements end where
 * their nearest open ancestor closes, or at the end of the document.
 */
function scanElements(html, limit = 150_000) {
  const source = String(html ?? '');
  const elements = [];
  const open = [];
  let index = 0;
  while (index < source.length && elements.length < limit) {
    const lt = source.indexOf('<', index);
    if (lt < 0) break;
    const tag = readTag(source, lt);
    if (!tag) { index = lt + 1; continue; }
    index = tag.end;
    if (tag.kind !== 'tag') continue;
    if (tag.closing) {
      for (let depth = open.length - 1; depth >= 0; depth -= 1) {
        if (open[depth].name !== tag.name) continue;
        for (let inner = open.length - 1; inner >= depth; inner -= 1) {
          open[inner].contentEnd = tag.start;
          open[inner].end = inner === depth ? tag.end : tag.start;
        }
        open.length = depth;
        break;
      }
      continue;
    }
    const element = { name: tag.name, attrs: tag.attrs, start: tag.start, contentStart: tag.end, contentEnd: tag.end, end: tag.end };
    elements.push(element);
    if (tag.selfClosing || VOID_ELEMENTS.has(tag.name)) continue;
    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      const raw = rawTextEnd(source, tag.name, tag.end);
      element.contentEnd = raw.contentEnd;
      element.end = raw.end;
      index = raw.end;
      continue;
    }
    open.push(element);
  }
  for (const element of open) { element.contentEnd = source.length; element.end = source.length; }
  return elements;
}

function innerHtml(html, element) {
  return String(html).slice(element.contentStart, element.contentEnd);
}

function contains(outer, inner) {
  return inner.start >= outer.contentStart && inner.end <= outer.contentEnd;
}

function isBoilerplateElement(tag) {
  if (CONTENT_CONTAINERS.has(tag.name)) return false;
  const idToken = String(tag.attrs.id ?? '').trim().toLowerCase();
  const classes = classList(tag);
  if (CONTENT_MARKER.test(idToken) || classes.some((token) => CONTENT_MARKER.test(token))) return false;
  return BOILERPLATE_ANYWHERE.test(`${idToken} ${classes.join(' ')}`)
    || BOILERPLATE_TOKEN.test(idToken) || classes.some((token) => BOILERPLATE_TOKEN.test(token));
}

function isHiddenElement(tag) {
  const role = String(tag.attrs.role ?? '').toLowerCase();
  return DROPPED_ELEMENTS.has(tag.name)
    || role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'search'
    || String(tag.attrs['aria-hidden'] ?? '').toLowerCase() === 'true'
    || tag.attrs.hidden !== undefined
    || isBoilerplateElement(tag);
}

/**
 * Visible text of an HTML fragment: skips script/style/noscript/navigation
 * chrome, keeps list items on their own "• " / "1. " lines, and decodes
 * entities. Quoted attribute values never leak into the output.
 */
export function htmlToText(html, maxLength = 100_000) {
  const source = String(html ?? '');
  const output = [];
  let outputLength = 0;
  const lists = [];
  const skipped = []; // names of dropped elements we are inside, with depth
  let index = 0;

  function emit(text) {
    if (!text) return;
    output.push(text);
    outputLength += text.length;
  }

  function emitBreak(prefix = '') {
    const last = output.length ? output[output.length - 1] : '\n';
    if (!/\n\s*$/.test(last)) emit('\n');
    emit(prefix);
  }

  while (index < source.length && outputLength < maxLength * 2) {
    const lt = source.indexOf('<', index);
    const textEnd = lt < 0 ? source.length : lt;
    if (textEnd > index && !skipped.length) {
      emit(decodeHtmlEntities(source.slice(index, textEnd)).replace(/\s+/g, ' '));
    }
    if (lt < 0) break;
    const tag = readTag(source, lt);
    if (!tag) {
      if (!skipped.length) emit('<');
      index = lt + 1;
      continue;
    }
    index = tag.end;
    if (tag.kind !== 'tag') continue;
    const { name } = tag;

    if (tag.closing) {
      if (skipped.length) {
        const top = skipped[skipped.length - 1];
        if (top.name === name) {
          top.depth -= 1;
          if (top.depth === 0) skipped.pop();
        }
        continue;
      }
      if (name === 'ol' || name === 'ul') lists.pop();
      if (BLOCK_ELEMENTS.has(name)) emitBreak();
      else if (name === 'td' || name === 'th') emit(' ');
      continue;
    }

    if (skipped.length) {
      const top = skipped[skipped.length - 1];
      // </head> is optional in HTML; an opening <body> ends the head either way.
      if (top.name === 'head' && name === 'body') { skipped.pop(); continue; }
      // Script text inside a dropped region may contain literal "</div>" strings; step over it whole.
      if (RAW_TEXT_ELEMENTS.has(name) && !tag.selfClosing) { index = rawTextEnd(source, name, tag.end).end; continue; }
      if (top.name === name && !tag.selfClosing && !VOID_ELEMENTS.has(name)) top.depth += 1;
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(name)) {
      index = rawTextEnd(source, name, tag.end).end;
      continue;
    }
    if (isHiddenElement(tag)) {
      if (!tag.selfClosing && !VOID_ELEMENTS.has(name)) skipped.push({ name, depth: 1 });
      continue;
    }
    if (name === 'ol') lists.push({ ordered: true, count: 0 });
    else if (name === 'ul') lists.push({ ordered: false, count: 0 });
    if (name === 'li') {
      const list = lists[lists.length - 1];
      if (list?.ordered) { list.count += 1; emitBreak(`${list.count}. `); } else emitBreak('• ');
      continue;
    }
    if (name === 'img') {
      const alt = cleanText(tag.attrs.alt ?? '', 200);
      if (alt && !/^(?:image|photo|picture|logo|icon)$/i.test(alt)) emit(` ${alt} `);
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) emitBreak();
    else if (name === 'td' || name === 'th') emit(' ');
  }
  return cleanText(output.join(''), maxLength);
}

/**
 * Meta tags, the first content h1 and <title>, read with the quote-aware
 * scanner. An h1 inside the site header or navigation is the site name, not
 * the recipe, so the first h1 outside those elements wins. A <header> inside
 * <article> or <main> is the post's own header (WordPress themes put the title
 * in <header class="entry-header"><h1 class="entry-title">), not site chrome.
 */
function pageMetadata(html, elements = scanElements(html)) {
  const meta = {};
  let h1 = '';
  let title = '';
  const content = elements.filter((element) => element.name === 'article' || element.name === 'main');
  const chrome = elements.filter((element) => element.name === 'nav'
    || (element.name === 'header' && !content.some((container) => contains(container, element))));
  for (const element of elements) {
    if (element.name === 'meta') {
      const key = String(element.attrs.property ?? element.attrs.name ?? element.attrs['http-equiv'] ?? '').toLowerCase();
      const content = cleanText(element.attrs.content ?? '', 2_000);
      if (key && content && !(key in meta)) meta[key] = content;
    } else if (element.name === 'h1' && !h1 && !chrome.some((container) => contains(container, element))) {
      h1 = cleanText(htmlToText(innerHtml(html, element), 400), 300);
    } else if (element.name === 'title' && !title) {
      title = cleanText(htmlToText(innerHtml(html, element), 400), 300);
    }
  }
  const siteName = cleanText(meta['og:site_name'] ?? '', 200);
  if (h1 && siteName && h1.toLowerCase() === siteName.toLowerCase()) h1 = '';
  return { meta, h1, title, siteName };
}

// ---------------------------------------------------------------------------
// Drafts, quantities, ingredients
// ---------------------------------------------------------------------------

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

// "1. Preheat…", "Step 2: Bake…", "2) Serve": numbering that belongs to the list, not the step.
const STEP_PREFIX = /^(?:step\s*\d+\s*[:.)-]?|\d{1,2}\s*[.)](?!\d)|[•●▪◦-])\s*/i;

function makeInstruction(text, stepNumber, section = null) {
  const clean = cleanText(text, CLIENT_LIMITS.instruction).replace(STEP_PREFIX, '').trim();
  return { id: id('step'), stepNumber, section, text: clean, timerMinutes: parseDuration(clean) };
}

// Ordered aisle rules: the first pattern that matches the normalized ingredient
// name wins, so specific items (jarred sauces, fresh chiles) sit above the
// generic words that would otherwise claim them ("oil" before "olive",
// "fish sauce" before "fish").
const CHILE = String.raw`chil(?:i|e|li)(?:es|s)?`;
const GROCERY_RULES = [
  ['Frozen', String.raw`\bfrozen\b|ice cream|popsicle|sorbet`],
  ['Canned & Jarred', String.raw`\bcanned\b|\bcan of\b|\bjar(?:red)? of\b|chickpeas?|garbanzo|(?<!\b(?:green|string|runner|wax|snap|french|fava|broad|soy|vanilla|coffee|cocoa|jelly) )\bbeans?\b(?! sprouts?)|lentils?|\bbroth\b|\bstock\b|bouillon|coconut (?:milk|cream)|tomato (?:paste|sauce|pur[ée]e)|(?:crushed|diced|whole|fire-roasted|canned|san marzano) tomatoes|passata|marinara|pasta sauce|pizza sauce|enchilada sauce|cream of \w+ soup|\bsoup\b|\bolives?\b(?! oil)|capers|pickles?|sauerkraut|kimchi|artichoke hearts|roasted red peppers|salsa|applesauce|peanut butter|almond butter|tahini|\bjam\b|marmalade|nutella|chipotles? in adobo|pumpkin pur[ée]e|evaporated milk|condensed milk`],
  ['Sauces & Condiments', String.raw`\boil\b|cooking spray|vinegar|mustard(?! (?:seeds?|powder|greens))|mayonnaise|\bmayo\b|ketchup|soy sauce|tamari|hot sauce|sriracha|tabasco|worcestershire|fish sauce|oyster sauce|hoisin|bbq sauce|barbecue sauce|dressing|\bpesto\b|teriyaki|\bmirin\b|rice wine|shaoxing|gochujang|harissa|\bmiso\b|buffalo sauce|ranch(?! seasoning)|relish|chutney|\baioli\b|salsa verde|curry paste|${CHILE} (?:paste|crisp|garlic sauce)|sambal`],
  ['Dairy & Eggs', String.raw`\beggs?\b(?! (?:noodles?|roll))|egg whites?|egg yolks?|cream cheese|sour cream|heavy cream|whipping cream|half[- ]and[- ]half|\bcream\b(?! of tartar)|(?<!powdered )\bmilk\b(?! (?:chocolate|powder))|\bbutter\b|\bghee\b|\bcheese\b|mozzarella|parmesan|parmigiano|pecorino|cheddar|\bfeta\b|ricotta|mascarpone|\bbrie\b|gouda|gruy[èe]re|halloumi|paneer|yog(?:h)?urt|cr[èe]me fra[îi]che|buttermilk|cottage cheese|queso`],
  ['Meat & Seafood', String.raw`\b(?:chicken|beef|pork|turkey|lamb|steak|fish)\b(?! (?:seasoning|salt|rub|bouillon|broth|stock|base|sauce|flavou?r|gravy))|salmon|shrimp|prawns?|sausages?|\btuna\b|\bbacon\b|\bham\b|chorizo|pancetta|prosciutto|\bcod\b|tilapia|halibut|scallops?|\bcrab\b(?! ?apple)|lobster|mussels|clams|anchov(?:y|ies)|\bbrisket\b|\bchuck\b|(?:chuck|pot|rib|rump|sirloin|tenderloin|loin|shoulder|round|tri-tip|eye of round|top round|bottom round) roast|\btenderloin\b|\bsirloin\b|\bribeye\b|\bflank\b|skirt steak|(?:^|\b(?:short|spare|baby back|back|beef|pork|lamb|prime|country[- ]style) )ribs?\b|rack of (?:ribs|lamb)|meatballs?|pepperoni|salami|\bduck\b|\bveal\b|\bvenison\b|\btofu\b|tempeh`],
  ['Bakery', String.raw`\bbread\b(?! ?(?:crumbs|flour))|(?<!\b(?:egg|spring|summer) )\brolls?\b|tortillas?\b(?! chips)|baguette|\bbuns?\b|\bpita\b(?! chips)|\bnaan\b|bagels?|croissants?|(?<!lettuce )\bwraps?\b|flatbread|ciabatta|sourdough|brioche|english muffins?|crumpets?|pizza dough|pie crusts?|puff pastry|phyllo|filo|croutons?|breadsticks?`],
  // Fresh chiles and herbs that the spice rule below would otherwise claim.
  ['Produce', String.raw`bell peppers?|jalape[ñn]os?|poblanos?|serranos?|habaneros?|fresnos?|(?<!\b(?:dried|crushed|ground) )\b${CHILE}\b(?! (?:powder|flakes?|paste|sauce|oil|crisp|garlic))|(?<!crushed )red peppers?(?! flakes?)|green peppers?|sweet peppers?|\bpeppers\b(?! flakes?)|fresh (?:thyme|rosemary|oregano|ginger|turmeric|herbs)`],
  ['Spices & Seasonings', String.raw`\bsalt\b|\bpepper\b|peppercorns?|\bcumin\b|paprika|oregano|\bthyme\b|rosemary|cinnamon|nutmeg|seasoning|\bspices?\b|${CHILE} (?:powder|flakes?)|red pepper flakes|crushed red pepper|dried ${CHILE}|chil(?:e|i) de [aá]rbol|anchos?\b|guajillos?\b|curry powder|turmeric|ground (?:coriander|ginger|cloves|cumin|cardamom|mustard|allspice|nutmeg|cinnamon|fennel|sumac)|coriander seeds?|garlic powder|onion powder|mustard powder|dry mustard|bay lea(?:f|ves)|cayenne|cardamom|cloves? (?:ground|whole)|whole cloves|allspice|\bsumac\b|za'?atar|garam masala|five[- ]spice|smoked paprika|italian seasoning|everything bagel|old bay|\bmsg\b|star anise|fennel seeds?|mustard seeds?|cumin seeds?|sesame seeds?|poppy seeds?|vanilla (?:extract|bean|paste)|almond extract|saffron|dill weed|dried (?:basil|parsley|oregano|thyme|dill|herbs|mint|sage|rosemary|chives)`],
  ['Produce', String.raw`\bonions?\b|\bgarlic\b|tomato(?:es)?|potato(?:es)?(?! (?:chips|starch|flour))|carrots?|lemons?|limes?|spinach|\bkale\b|\bbasil\b|parsley|cilantro|coriander|\bmint\b|\bdill\b|\bchives\b|\bsage\b|tarragon|avocados?|lettuce|\bginger\b|cucumbers?|cabbage|apples?|bananas?|berries|strawberr(?:y|ies)|blueberr(?:y|ies)|raspberr(?:y|ies)|mushrooms?|zucchini|courgette|squash|broccoli|cauliflower|celery|scallions?|green onions?|spring onions?|shallots?|leeks?|\bcorn\b(?! ?(?:starch|flour|meal|syrup))|\bherbs\b|oranges?|pears?|peach(?:es)?|mango(?:es)?|pineapple|grapes?|asparagus|eggplant|aubergine|arugula|rocket|romaine|cherries|watermelon|melon|pomegranate|sweet potato(?:es)?|beets?|radish(?:es)?|turnips?|parsnips?|brussels sprouts|green beans|string beans|runner beans|wax beans|snap beans|haricots? verts?|fava beans|broad beans|bean sprouts|snap peas|\bpeas\b|edamame|\bfennel\b|bok choy|lemongrass|\bgreens\b|chard|watercress|endive|radicchio|microgreens`],
  ['Pasta, Rice & Grains', String.raw`\bpasta\b|spaghetti|penne|rigatoni|macaroni|fettuccine|linguine|tagliatelle|fusilli|farfalle|\borzo\b|lasagna|lasagne|gnocchi|ravioli|tortellini|noodles?|ramen|\brice\b(?! (?:vinegar|wine|flour|paper))|quinoa|couscous|\boats?\b|oatmeal|barley|farro|bulgur|polenta|\bgrits\b|cornmeal`],
  ['Pantry', String.raw`\bflour\b|\bsugar\b|\bhoney\b|maple syrup|\bsyrup\b|baking (?:powder|soda)|cornstarch|corn ?flour|potato starch|tapioca|arrowroot|cream of tartar|\byeast\b|\bcocoa\b|chocolate|\bnuts?\b|almonds?|walnuts?|pecans?|cashews?|pistachios?|peanuts?|hazelnuts?|\bseeds?\b|breadcrumbs?|bread crumbs|panko|raisins?|dates?\b|cranberries|dried (?:fruit|apricots|cherries)|coconut|molasses|agave|stevia|protein powder|crackers?|chips|granola|cereal|vanilla|gelatin|powdered sugar|brown sugar|shortening|lard|sprinkles|marshmallows?|graham crackers?|rice paper`],
].map(([category, source]) => [new RegExp(source), category]);

function groceryCategoryFor(value, unit = null) {
  const name = normalizeName(value);
  // "1 can tuna", "1 jar marinara": the container says where it is shelved.
  if (/^(?:can|jar)$/.test(unit ?? '') && !/\bfrozen\b/.test(name)) return 'Canned & Jarred';
  return GROCERY_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? 'Other';
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
const FRACTION_CLASS = '[¼⅓½⅔¾⅛⅜⅝⅞]';
const QUANTITY_TOKEN = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+\\s*${FRACTION_CLASS}|${FRACTION_CLASS}|\\d+(?:[.,]\\d+)?)`;
// Units that commonly follow a number with no space: "600g", "250ml", "1.5kg", "2tbsp".
const ATTACHED_UNITS = '(?:kg|g|mg|ml|cl|dl|l|lbs?|oz|tbsp|tsp|cups?|x)';
const QUANTITY_PREFIX = new RegExp(`^${QUANTITY_TOKEN}(?=\\s|$|${ATTACHED_UNITS}\\b)`, 'i');
const RANGE_PREFIX = new RegExp(`^(${QUANTITY_TOKEN})\\s*(?:-|–|—|to|or)\\s*(${QUANTITY_TOKEN})(?=\\s|$|${ATTACHED_UNITS}\\b)`, 'i');
const WORD_QUANTITY = /^(?:a |an |one |some )?(?:small |big |large |generous |good |tiny )?(splash|pinch|handful|dash|knob|drizzle|squeeze|glug|sprinkle|bunch|few|couple|slug|dollop|scoop|scattering|grating)\b(?: of)?\s*/i;
const HALF_PREFIX = /^(?:half|½)\s+(?:an?|of an?)\s+/i;
// "One 3-pound roast", "Two 15-ounce cans", "a dozen eggs": a spelled-out count.
// It must be followed by whitespace ("Seven-spice blend", "One-pot seasoning"
// are names) and not by a word that makes it a name or a time ("Five spice
// powder", "Ten minute marinade").
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };
const WORD_COUNT_PREFIX = /^(?:(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)|(?:a|one)\s+(dozen))\s+(?!(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|spice|cheese|ingredients?|pot|pan|bowl|steps?|percent|%)\b)/i;
// A size or weight written as an adjective after the count: "3- to 5-pound",
// "2-to-3-inch", "15-ounce". It describes the item, so it becomes a note.
const SIZE_UNITS = String.raw`(pounds?|lbs?|ounces?|oz|inch(?:es)?|in|cm|mm|kg|grams?|g|quarts?|qt|liters?|litres?|l|cups?|gallons?|gal|pints?|pt)`;
const SIZE_NUMBER = String.raw`\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?(?:\s*[¼⅓½⅔¾⅛⅜⅝⅞])?`;
const SIZE_RANGE_SPEC = new RegExp(String.raw`^(${SIZE_NUMBER})\s*-?\s*(?:to|-|–|—)\s*-?\s*(${SIZE_NUMBER})\s*-\s*${SIZE_UNITS}\b\.?\s*`, 'i');
const SIZE_SPEC = new RegExp(String.raw`^(${SIZE_NUMBER})\s*-\s*${SIZE_UNITS}\b\.?\s*`, 'i');
const SIZE_UNIT_LABELS = [
  [/^(?:pounds?|lbs?)$/i, 'lb'], [/^(?:ounces?|oz)$/i, 'oz'], [/^(?:inch(?:es)?|in)$/i, 'in'], [/^(?:grams?|g)$/i, 'g'],
  [/^(?:quarts?|qt)$/i, 'qt'], [/^(?:liters?|litres?|l)$/i, 'l'], [/^cups?$/i, 'cup'], [/^(?:gallons?|gal)$/i, 'gal'], [/^(?:pints?|pt)$/i, 'pt'],
];

function sizeUnitLabel(unit) {
  return SIZE_UNIT_LABELS.find(([pattern]) => pattern.test(unit))?.[1] ?? unit.toLowerCase();
}

/** Splits a leading "3- to 5-pound" / "15-ounce" adjective off the remainder and returns it as a note. */
function takeSizeSpec(remainder) {
  const range = remainder.match(SIZE_RANGE_SPEC);
  if (range) return { note: `${range[1].replace(/\s+/g, '')}–${range[2].replace(/\s+/g, '')} ${sizeUnitLabel(range[3])}`, remainder: remainder.slice(range[0].length).trim() };
  const single = remainder.match(SIZE_SPEC);
  if (single) return { note: `${single[1].replace(/\s+/g, '')} ${sizeUnitLabel(single[2])}`, remainder: remainder.slice(single[0].length).trim() };
  return { note: null, remainder };
}
const TO_TASTE = /\b(?:to taste|as needed|as required|if needed|if desired|for serving|to serve|for garnish|for drizzling|for sprinkling|for dusting|for greasing|for frying|for brushing|for the pan)\b/i;
// Trailing "why" clauses that are not part of the ingredient name: "water to
// loosen", "oil for frying", "salt, plus more to taste".
const PURPOSE_CLAUSE = /[,;–-]?\s*(?:(?:plus|or|and)\s+)?(?:(?:more|extra|additional|some)\s+)?(?:a\s+(?:little|bit|few)\s+)?(?:more\s+)?(?:to (?:taste|serve|loosen|thin(?: out)?|deglaze|finish|coat|cover|top|garnish|drizzle|brush|grease|season)|as needed|as required|if needed|if desired|for (?:serving|garnish|garnishing|drizzling|sprinkling|dusting|greasing|frying|brushing|topping|the pan))\b.*$/i;
// What a purpose clause can leave behind: "Kosher salt, plus" or an add-on item
// such as "lime, plus lime wedges".
const DANGLING_ADDITION = /,?\s*(?:plus|or|and)\s+(?:(?:more|extra|additional)\s*)?$|,\s*plus\s+[^,]{1,60}$/i;
const WATER_LIKE =/^(?:(?:hot|cold|warm|boiling|iced|ice|tap|filtered|lukewarm|room temperature|cool)\s+)*(?:water|ice|ice cubes?)$/i;
const TRACE_STAPLES = /^(?:(?:sea|kosher|table|flaky|fine|coarse|black|white|ground|cracked|freshly ground)\s+)*(?:salt|pepper|salt and pepper|salt & pepper|oil|olive oil|water|sugar|flour|vinegar|lemon juice|lime juice)$/i;
const PREPARATION_WORDS = /^(?:chopped|minced|diced|sliced|grated|shredded|crushed|peeled|unpeeled|skin[- ]on|melted|softened|cubed|halved|quartered|julienned|thinly|finely|roughly|coarsely|torn|trimmed|rinsed|drained|divided|beaten|whisked|toasted|crumbled|zested|juiced|cut|cooked|uncooked|thawed|chilled|seeded|deseeded|de-seeded|deveined|packed|sifted|smashed|mashed|pressed|squeezed|patted|warmed|cooled|left whole|kept whole|at room temperature|room temperature|plus more|plus extra|or more|for|to|optional|about|roughly|lightly|freshly|ground|pitted|cored|stemmed|washed|(?:seeds?|stems?|ribs?|skins?|bones?|pits?|cores?|shells?|membranes?|veins?|strings?)(?:\s+and\s+\w+)?\s+(?:removed|discarded|reserved|scraped))\b/i;

function parseQuantityToken(token) {
  const text = cleanText(token, 30).replace(',', '.').replace(/(\d)\s+(?=[¼⅓½⅔¾⅛⅜⅝⅞])/, '$1');
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
  ['fluid ounces', 'fl oz'], ['fluid ounce', 'fl oz'], ['fl oz', 'fl oz'], ['fl. oz.', 'fl oz'],
  ['kilograms', 'kg'], ['kilogram', 'kg'], ['kgs', 'kg'], ['kg', 'kg'],
  ['milliliters', 'ml'], ['millilitres', 'ml'], ['milliliter', 'ml'], ['millilitre', 'ml'], ['mls', 'ml'], ['ml', 'ml'],
  ['liters', 'l'], ['litres', 'l'], ['liter', 'l'], ['litre', 'l'], ['ltr', 'l'],
  ['ounces', 'oz'], ['ounce', 'oz'], ['oz.', 'oz'], ['oz', 'oz'],
  ['pounds', 'lb'], ['pound', 'lb'], ['lbs.', 'lb'], ['lbs', 'lb'], ['lb.', 'lb'], ['lb', 'lb'],
  ['grams', 'g'], ['gram', 'g'], ['gr', 'g'], ['g', 'g'],
  ['packages', 'package'], ['package', 'package'], ['packets', 'package'], ['packet', 'package'], ['pkg', 'package'],
  ['cloves', 'clove'], ['clove', 'clove'], ['slices', 'slice'], ['slice', 'slice'],
  ['cups', 'cup'], ['cup', 'cup'], ['c.', 'cup'],
  ['tbsp.', 'tbsp'], ['tbsp', 'tbsp'], ['tbs', 'tbsp'], ['tbl', 'tbsp'], ['tsp.', 'tsp'], ['tsp', 'tsp'],
  ['cans', 'can'], ['can', 'can'], ['tins', 'can'], ['tin', 'can'], ['jars', 'jar'], ['jar', 'jar'],
  ['dozen', 'dozen'], ['bunches', 'bunch'], ['bunch', 'bunch'], ['sticks', 'stick'], ['stick', 'stick'],
  ['pints', 'pint'], ['pint', 'pint'], ['quarts', 'quart'], ['quart', 'quart'], ['gallons', 'gallon'], ['gallon', 'gallon'],
  ['heads', 'head'], ['head', 'head'], ['stalks', 'stalk'], ['stalk', 'stalk'], ['sprigs', 'sprig'], ['sprig', 'sprig'],
  ['pieces', 'piece'], ['piece', 'piece'], ['handfuls', 'handful'], ['handful', 'handful'],
  ['pinches', 'pinch'], ['pinch', 'pinch'], ['dashes', 'dash'], ['dash', 'dash'], ['x', 'each'],
].sort((a, b) => b[0].length - a[0].length);

function takeUnit(remainder) {
  const lower = remainder.toLowerCase();
  const match = UNIT_ALIASES.find(([alias]) => lower === alias || lower.startsWith(`${alias} `));
  if (match) return { unit: match[1], remainder: remainder.slice(match[0].length).replace(/^\.\s*/, '').trim() };
  const attached = lower.match(new RegExp(`^${ATTACHED_UNITS}(?=[^a-z]|$)`, 'i'));
  if (attached) {
    const alias = UNIT_ALIASES.find(([name]) => name === attached[0].toLowerCase());
    if (alias) return { unit: alias[1], remainder: remainder.slice(attached[0].length).trim() };
  }
  return { unit: 'each', remainder };
}

function splitPreparation(text) {
  const commaIndex = text.indexOf(',');
  if (commaIndex < 0) return { name: text, preparation: null };
  const suffix = text.slice(commaIndex + 1).trim();
  if (!PREPARATION_WORDS.test(suffix)) return { name: text, preparation: null };
  return { name: text.slice(0, commaIndex).trim(), preparation: cleanText(suffix, 500) || null };
}

export function parseIngredient(rawText, section = null) {
  const raw = cleanText(htmlToText(rawText, 2_000), 1_000)
    .replace(/^(?:[-–—•▪◦*·]|\d+[.)](?!\d))\s*/, '')
    .replace(/^[\p{Extended_Pictographic}\s]+/u, '')
    // "¾ cup brown sugar • packed": a mid-line bullet separates the preparation like a comma would.
    .replace(/\s+[•·▪◦|]\s+/g, ', ')
    .trim();
  let remainder = raw;
  let quantity = null;
  let quantityMax = null;
  let approximate = false;
  let unit = null;

  // "1 (14 oz) can chickpeas", "penne pasta (uncooked) ($0.75)": lift the
  // parentheticals out first so the unit that follows them is still found.
  const notes = [];
  for (let lifted = 0; lifted < 3; lifted += 1) {
    const noteMatch = remainder.match(/\(([^()]{1,120})\)/);
    if (!noteMatch) break;
    notes.push(cleanText(noteMatch[1], 200));
    remainder = `${remainder.slice(0, noteMatch.index)} ${remainder.slice(noteMatch.index + noteMatch[0].length)}`.replace(/\s+/g, ' ').trim();
  }
  let note = notes.filter(Boolean).join(', ') || null;

  const rangeMatch = remainder.match(RANGE_PREFIX);
  const quantityMatch = rangeMatch ? null : remainder.match(QUANTITY_PREFIX);
  if (rangeMatch) {
    quantity = parseQuantityToken(rangeMatch[1]);
    quantityMax = parseQuantityToken(rangeMatch[2]);
    approximate = true;
    remainder = remainder.slice(rangeMatch[0].length).trim();
  } else if (quantityMatch) {
    quantity = parseQuantityToken(quantityMatch[0]);
    remainder = remainder.slice(quantityMatch[0].length).trim();
  } else {
    const wordCount = remainder.match(WORD_COUNT_PREFIX);
    const half = wordCount ? null : remainder.match(HALF_PREFIX);
    if (wordCount && !WORD_QUANTITY.test(remainder)) {
      quantity = rational(NUMBER_WORDS[(wordCount[1] ?? wordCount[2]).toLowerCase()]);
      remainder = remainder.slice(wordCount[0].length).trim();
    } else if (half) {
      quantity = rational(1, 2);
      remainder = remainder.slice(half[0].length).trim();
    }
  }
  if (quantity) {
    // "One 3- to 5-pound chuck roast", "2 15-ounce cans": the size is a note, not a unit.
    const sized = takeSizeSpec(remainder);
    if (sized.note) {
      note = note ? `${note}, ${sized.note}` : sized.note;
      remainder = sized.remainder;
    }
    const taken = takeUnit(remainder);
    unit = taken.unit;
    remainder = taken.remainder;
  } else {
    const word = remainder.match(WORD_QUANTITY);
    if (word) {
      approximate = true;
      unit = /^(?:bunch|handful|pinch|dash)$/i.test(word[1]) ? word[1].toLowerCase() : null;
      remainder = remainder.slice(word[0].length).trim();
    }
  }
  remainder = remainder.replace(/^of\s+/i, '');
  const toTaste = TO_TASTE.test(remainder) || TO_TASTE.test(note ?? '');
  remainder = remainder.replace(PURPOSE_CLAUSE, '').replace(DANGLING_ADDITION, '').trim();
  const optional = /\boptional\b/i.test(raw);
  remainder = remainder.replace(/\s*[(,]?\s*optional\)?\s*$/i, '').replace(/^optional[:\s]+/i, '').trim();

  const { name, preparation } = splitPreparation(remainder);
  let ingredientName = cleanText(name, 500).replace(/[,;:]\s*$/, '') || raw;
  let descriptor = null;
  const descriptorMatch = ingredientName.match(/^(small|medium|large)\s+(.+)$/i);
  if (descriptorMatch) {
    descriptor = descriptorMatch[1].toLowerCase();
    ingredientName = descriptorMatch[2];
  }
  const normalizedIngredient = normalizeName(ingredientName);
  const traceAmount = approximate && !quantity && /\b(?:splash|pinch|dash|drizzle|squeeze|sprinkle|glug)\b/i.test(raw);
  const skipGrocery = WATER_LIKE.test(normalizedIngredient) || (traceAmount && TRACE_STAPLES.test(normalizedIngredient));
  const needsReview = !quantity || !normalizedIngredient || /\bor\b/i.test(ingredientName) || /[<>]/.test(ingredientName);

  return {
    id: id('ing'),
    rawText: raw,
    quantity,
    unit,
    normalizedUnit: unit,
    ingredientName,
    normalizedIngredient,
    descriptor,
    preparation,
    groceryCategory: groceryCategoryFor(normalizedIngredient, unit),
    optional,
    section,
    confidence: needsReview ? 0.62 : 0.94,
    needsReview,
    quantityMax,
    approximate,
    toTaste,
    skipGrocery,
    note,
  };
}

function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  const text = cleanText(firstText(value), 200);
  if (!text) return null;
  const iso = text.match(/^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (iso) {
    const minutes = Number(iso[1] ?? 0) * 10_080 + Number(iso[2] ?? 0) * 1_440 + Number(iso[3] ?? 0) * 60
      + Number(iso[4] ?? 0) + Number(iso[5] ?? 0) / 60;
    return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
  }
  const clock = text.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i)?.[1] ?? 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i)?.[1] ?? 0);
  return hours || minutes ? Math.round(hours * 60 + minutes) : null;
}

// ---------------------------------------------------------------------------
// Schema.org JSON-LD
// ---------------------------------------------------------------------------

function firstText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return cleanText(value, 10_000);
  if (Array.isArray(value)) return value.map(firstText).find(Boolean) ?? '';
  if (typeof value === 'object') return firstText(value.name ?? value.text ?? value.url ?? value.contentUrl ?? value['@id']);
  return '';
}

function textList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return unique(value.flatMap(textList));
  if (typeof value === 'string') return unique(value.split(/[,;]\s*/).map((item) => cleanText(item, 200)));
  const text = firstText(value);
  return text ? [text] : [];
}

/** Author names only, never a profile URL or an unresolved @id; two authors read "Ada & Bo". */
function authorText(value) {
  const names = (Array.isArray(value) ? value : [value])
    .map((entry) => (typeof entry === 'object' && entry ? firstText(entry.name) : firstText(entry)))
    .map((name) => cleanText(htmlToText(name, 300), 200))
    .filter((name) => name && !/^[a-z][a-z\d+.-]*:\/\//i.test(name) && !/^(?:www\.|#|\/)/i.test(name) && !/\.[a-z]{2,}\/\S*$/i.test(name));
  return unique(names).slice(0, 2).join(' & ') || null;
}

/** "4 to 6 servings" → 4, "Makes 24 cookies" → 24, a QuantitativeValue → its value. */
function parseServings(value) {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = parseServings([candidate.value, candidate.minValue, candidate.name, candidate.text].filter((item) => item != null));
      if (nested != null) return nested;
      continue;
    }
    const match = firstText(candidate).match(/\b(\d+(?:\.\d+)?)\b/);
    if (match && Number(match[1]) > 0) return Number(match[1]);
  }
  return null;
}

function safeDisplayImage(value) {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    const raw = typeof candidate === 'object' && candidate
      ? firstText(candidate.url ?? candidate.contentUrl ?? candidate.thumbnailUrl ?? candidate['@id'])
      : candidate;
    try {
      const url = new URL(String(raw ?? ''));
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* Ignore malformed image URLs. */ }
  }
  return null;
}

function stepTexts(value) {
  const text = typeof value === 'string' && /<[a-z][^>]*>/i.test(value) ? htmlToText(value, 20_000) : cleanText(firstText(value), 20_000);
  return text
    .split(/\n+|(?<=\.)\s+(?=\d{1,2}[.)]\s+[A-Z])/)
    .map((item) => item.replace(/^(?:step\s*\d+\s*[:.)-]?|\d+\s*[.)](?!\d)|[•●▪◦-])\s*/i, '').trim())
    .filter((item) => item.length > 1);
}

function typeNames(value) {
  const types = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
  return types.filter(Boolean).map((type) => String(type).toLowerCase().replace(/^.*[/#:]/, ''));
}

function flattenInstructions(value, section = null, output = [], depth = 0) {
  if (depth > 12 || value == null || output.length >= CLIENT_LIMITS.instructions) return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenInstructions(item, section, output, depth + 1);
    return output;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    for (const text of stepTexts(value)) pushStep(output, section, text);
    return output;
  }
  if (typeof value !== 'object') return output;
  const types = typeNames(value);
  const isSection = types.includes('howtosection');
  const nextSection = isSection ? cleanText(firstText(value.name), 200) || section : section;
  const nested = value.itemListElement ?? value.steps ?? value.recipeInstructions ?? value.item;
  // A ListItem may wrap its step as an object or as a plain string ("item": "Preheat oven.").
  if (nested != null && (typeof nested === 'object' || typeof nested === 'string')) flattenInstructions(nested, nextSection, output, depth + 1);
  else {
    // A HowToStep may carry its wording in text, description or only name ("" counts as missing).
    const text = [value.text, value.description, value.name].find((candidate) => firstText(candidate)) ?? '';
    if (types.includes('howtotip')) appendTip(output, text);
    else for (const step of stepTexts(text)) pushStep(output, nextSection, step);
  }
  return output;
}

/** A HowToTip belongs to the step it follows, not on its own line in the method. */
function appendTip(output, text) {
  const tip = cleanText(firstText(text), 2_000);
  if (!tip) return;
  const previous = output[output.length - 1];
  if (!previous) { output.pendingTip = `${output.pendingTip ?? ''} Tip: ${tip}`.trim(); return; }
  if (!normalizeName(previous.text).includes(normalizeName(tip))) previous.text = cleanText(`${previous.text} Tip: ${tip}`, CLIENT_LIMITS.instruction);
}

function pushStep(output, section, text) {
  let clean = cleanText(text, CLIENT_LIMITS.instruction);
  if (!clean) return;
  const key = normalizeName(clean);
  output.seenKeys ??= new Set();
  if (output.seenKeys.has(key)) return;
  output.seenKeys.add(key);
  if (output.pendingTip) { clean = cleanText(`${clean} ${output.pendingTip}`, CLIENT_LIMITS.instruction); output.pendingTip = ''; }
  output.push({ section, text: clean });
}

function isRecipeNode(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeNames(value).includes('recipe');
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
    for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child, depth + 1);
  }
  visit(value, 0);
  return recipes;
}

/** JSON forbids raw control characters inside string literals; CMS output has them anyway. */
function spaceControlCharactersInStrings(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      else if (code < 0x20) { output += ' '; continue; }
    } else if (character === '"') inString = true;
    output += character;
  }
  return output;
}

function parseJsonLdBlock(raw) {
  const cleaned = String(raw ?? '')
    .replace(/^\ufeff/, '')
    .replace(/^\s*(?:<!--(?:(?!-->)[\s\S])*-->\s*)+/, '')
    .replace(/^\s*<!--/, '')
    .replace(/(?:\s*<!--(?:(?!-->)[\s\S])*-->)+\s*$/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\s*\/\/\s*<!\[CDATA\[/, '')
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\/\/\s*\]\]>\s*$/, '')
    .replace(/\]\]>\s*$/, '')
    .trim()
    .replace(/;\s*$/, '');
  const attempts = [cleaned, spaceControlCharactersInStrings(cleaned)];
  if (/^&quot;|&quot;\s*:/.test(cleaned)) attempts.push(decodeHtmlEntities(cleaned));
  // Trailing junk after the document (a cache marker, a stray tag): cut at the last bracket.
  const lastBracket = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastBracket > 0 && lastBracket < cleaned.length - 1) attempts.push(spaceControlCharactersInStrings(cleaned.slice(0, lastBracket + 1)));
  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch { /* Try the next conservative normalization. */ }
  }
  return null;
}

export function extractJsonLdNodes(html) {
  const nodes = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  let scriptsChecked = 0;
  while ((match = scriptPattern.exec(String(html ?? ''))) && scriptsChecked < 200) {
    if (!/\btype\s*=\s*(?:["']\s*)?application\/ld\+json\b/i.test(match[1])) continue;
    scriptsChecked += 1;
    const parsed = parseJsonLdBlock(match[2]);
    if (parsed != null) nodes.push(parsed);
  }
  return nodes;
}

export function extractRecipeJsonLd(html) {
  return extractJsonLdNodes(html).flatMap((node) => findRecipeNodes(node));
}

/** Every node that declares an @id, across all JSON-LD blocks, so references can be followed. */
export function collectNodesById(nodes) {
  const byId = new Map();
  const seen = new WeakSet();
  let visited = 0;
  function visit(node, depth) {
    if (depth > 32 || visited >= 20_000 || node == null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    visited += 1;
    if (!Array.isArray(node) && typeof node['@id'] === 'string' && Object.keys(node).length > 1 && !byId.has(node['@id'])) byId.set(node['@id'], node);
    for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child, depth + 1);
  }
  visit(nodes, 0);
  return byId;
}

/** Yoast-style graphs keep the Person and ImageObject in separate nodes referenced by @id. */
function resolveReference(value, nodesById, depth = 0) {
  if (depth > 4 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => resolveReference(item, nodesById, depth + 1));
  const reference = typeof value['@id'] === 'string' ? value['@id'] : null;
  if (!reference) return value;
  const hasOwnContent = Object.keys(value).some((key) => !key.startsWith('@') && value[key] != null && value[key] !== '');
  if (hasOwnContent) return value;
  const target = nodesById.get(reference);
  return target && target !== value ? resolveReference(target, nodesById, depth + 1) : value;
}

function isPaywalledNode(recipe) {
  const flag = recipe.isAccessibleForFree ?? recipe.hasPart?.isAccessibleForFree;
  return flag === false || String(flag).toLowerCase() === 'false';
}

/**
 * recipeIngredient entries: one string per line, but also a single
 * newline-joined string, HTML lists and inline tags, which are split and
 * stripped here. Raw newlines are split before the HTML pass, which would
 * otherwise fold them into spaces.
 */
function ingredientStrings(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    if (typeof entry === 'string') return entry.split(/\r?\n/).flatMap((line) => htmlToText(line, 2_000).split('\n'));
    return firstText(entry).split('\n');
  }).map((entry) => cleanText(entry, 1_000)).filter(Boolean);
}

export function draftFromSchemaRecipe(recipe, sourceUrl, nodesById = new Map()) {
  const draft = emptyDraft('url');
  draft.title = cleanText(htmlToText(firstText(recipe.name ?? recipe.headline), 1_200), CLIENT_LIMITS.title);
  draft.description = cleanText(htmlToText(firstText(recipe.description), 24_000), CLIENT_LIMITS.description);
  draft.heroImage = safeDisplayImage(resolveReference(recipe.image ?? recipe.thumbnailUrl, nodesById));
  draft.sourceURL = sourceUrl.href;
  draft.sourceName = sourceUrl.hostname.replace(/^www\./, '');
  draft.author = authorText(resolveReference(recipe.author ?? recipe.creator, nodesById));
  draft.servings = parseServings(recipe.recipeYield ?? recipe.yield);
  draft.prepTime = parseDuration(recipe.prepTime);
  draft.cookTime = parseDuration(recipe.cookTime);
  draft.totalTime = parseDuration(recipe.totalTime)
    ?? (draft.prepTime != null && draft.cookTime != null ? draft.prepTime + draft.cookTime : null);
  draft.cuisine = textList(recipe.recipeCuisine)[0] ?? null;
  draft.categories = textList(recipe.recipeCategory).slice(0, 20);
  draft.tags = textList(recipe.keywords).slice(0, 30);
  draft.ingredients = ingredientStrings(recipe.recipeIngredient ?? recipe.ingredients ?? [])
    .slice(0, CLIENT_LIMITS.ingredients)
    .map((ingredient) => parseIngredient(ingredient));
  draft.instructions = flattenInstructions(recipe.recipeInstructions ?? recipe.instructions)
    .slice(0, CLIENT_LIMITS.instructions)
    .map((instruction, index) => makeInstruction(instruction.text, index + 1, instruction.section));
  return draft;
}

function recipeEvidenceScore(draft) {
  if (!draft?.title) return 0;
  return (draft.ingredients?.length ?? 0) * 4
    + (draft.instructions?.length ?? 0) * 5
    + (draft.description ? 1 : 0)
    + (draft.heroImage ? 1 : 0);
}

function bestDraft(drafts) {
  return [...drafts].sort((left, right) => recipeEvidenceScore(right) - recipeEvidenceScore(left))[0] ?? null;
}

function bestSchemaDraft(html, sourceUrl) {
  const nodes = extractJsonLdNodes(html);
  const recipes = nodes.flatMap((node) => findRecipeNodes(node));
  const nodesById = recipes.length ? collectNodesById(nodes) : new Map();
  const draft = bestDraft(recipes.map((recipe) => draftFromSchemaRecipe(recipe, sourceUrl, nodesById)));
  return { draft, paywalled: recipes.some(isPaywalledNode) };
}

// ---------------------------------------------------------------------------
// Schema.org microdata
// ---------------------------------------------------------------------------

function itemprops(element) {
  return String(element.attrs.itemprop ?? '').split(/\s+/).filter(Boolean);
}

function microdataValue(html, element) {
  const { name, attrs } = element;
  if (attrs.content) return cleanText(attrs.content, 2_000);
  if (name === 'meta') return '';
  if (name === 'time' && attrs.datetime) return cleanText(attrs.datetime, 100);
  if ((name === 'img' || name === 'source' || name === 'video') && (attrs.src ?? attrs['data-src'])) return cleanText(attrs.src ?? attrs['data-src'], 2_000);
  if ((name === 'a' || name === 'link') && attrs.href && attrs.itemprop !== 'name' && !/name|author/.test(attrs.itemprop ?? '')) return cleanText(attrs.href, 2_000);
  return cleanText(htmlToText(innerHtml(html, element), 20_000), 20_000);
}

function microdataScopeFor(elements, index) {
  const element = elements[index];
  for (let probe = index - 1; probe >= 0; probe -= 1) {
    const candidate = elements[probe];
    if (candidate.attrs.itemscope !== undefined && contains(candidate, element)) return candidate;
  }
  return null;
}

export function extractMicrodataRecipe(html, sourceUrl, elements = scanElements(html)) {
  // Some sites (cooked.wiki) mark itemprop="recipeIngredient" without an enclosing
  // itemscope; the whole document then acts as the recipe scope.
  const documentScope = { name: '#document', attrs: {}, start: 0, contentStart: 0, contentEnd: html.length, end: html.length };
  const scope = elements.find((element) => element.attrs.itemscope !== undefined
    && /schema\.org\/recipe\b/i.test(element.attrs.itemtype ?? '')) ?? documentScope;
  const properties = {};
  elements.forEach((element, index) => {
    const names = itemprops(element);
    if (!names.length || !contains(scope, element)) return;
    if ((microdataScopeFor(elements, index) ?? documentScope) !== scope) return;
    for (const name of names) {
      let value;
      if (element.attrs.itemscope !== undefined) {
        const nameChild = elements.find((child) => contains(element, child) && itemprops(child).includes('name'));
        value = nameChild ? microdataValue(html, nameChild) : '';
      } else {
        value = microdataValue(html, element);
      }
      (properties[name] ??= []).push(value);
    }
  });
  const prop = (...names) => names.flatMap((name) => properties[name] ?? []).filter(Boolean);
  if (!prop('recipeIngredient', 'ingredients').length && !prop('recipeInstructions').length) return null;

  const draft = emptyDraft('url');
  draft.title = cleanText(prop('name', 'headline')[0] ?? '', 200);
  draft.description = cleanText(prop('description')[0] ?? '', 2_000);
  draft.heroImage = safeDisplayImage(prop('image', 'thumbnailUrl').map((value) => { try { return new URL(value, sourceUrl).href; } catch { return value; } }));
  draft.sourceURL = sourceUrl.href;
  draft.sourceName = sourceUrl.hostname.replace(/^www\./, '');
  draft.author = cleanText(prop('author')[0] ?? '', 200) || null;
  draft.servings = parseServings(prop('recipeYield', 'yield'));
  draft.prepTime = parseDuration(prop('prepTime')[0]);
  draft.cookTime = parseDuration(prop('cookTime')[0]);
  draft.totalTime = parseDuration(prop('totalTime')[0])
    ?? (draft.prepTime != null && draft.cookTime != null ? draft.prepTime + draft.cookTime : null);
  draft.cuisine = prop('recipeCuisine')[0] ?? null;
  draft.categories = unique(prop('recipeCategory').flatMap(textList)).slice(0, 20);
  draft.tags = unique(prop('keywords').flatMap(textList)).slice(0, 30);
  draft.ingredients = prop('recipeIngredient', 'ingredients')
    .flatMap((value) => value.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 300)
    .map((line) => parseIngredient(line));
  draft.instructions = prop('recipeInstructions')
    .flatMap((value) => stepTexts(value))
    .slice(0, 200)
    .map((text, index) => makeInstruction(text, index + 1));
  return draft;
}

// ---------------------------------------------------------------------------
// Recipe-card plugins (class-based HTML)
// ---------------------------------------------------------------------------

const RECIPE_PLUGINS = [
  {
    name: 'wprm',
    title: ['wprm-recipe-name'],
    ingredientItem: ['wprm-recipe-ingredient'],
    ingredientGroup: 'wprm-recipe-ingredient-group',
    groupHeading: ['wprm-recipe-group-name', 'wprm-recipe-ingredient-group-name'],
    instructionItem: ['wprm-recipe-instruction-text', 'wprm-recipe-instruction'],
    servings: ['wprm-recipe-servings'],
    prepTime: ['wprm-recipe-prep_time'],
    cookTime: ['wprm-recipe-cook_time'],
    totalTime: ['wprm-recipe-total_time'],
    summary: ['wprm-recipe-summary'],
  },
  {
    name: 'tasty',
    title: ['tasty-recipes-title'],
    listContainers: { ingredients: 'tasty-recipes-ingredients', instructions: 'tasty-recipes-instructions' },
    servings: ['tasty-recipes-yield'],
    summary: ['tasty-recipes-description'],
  },
  {
    name: 'mediavine',
    title: ['mv-create-title'],
    listContainers: { ingredients: 'mv-create-ingredients', instructions: 'mv-create-instructions' },
    servings: ['mv-create-time-yield'],
    summary: ['mv-create-description'],
  },
];

function elementsWithClass(elements, className) {
  return elements.filter((element) => hasClass(element, className));
}

function firstClassText(html, elements, classNames) {
  for (const className of classNames ?? []) {
    const element = elementsWithClass(elements, className)[0];
    if (element) return cleanText(htmlToText(innerHtml(html, element), 2_000), 1_000);
  }
  return '';
}

/** Plugin time fields are often a bare number with the unit in a sibling element; treat those as minutes. */
function pluginMinutes(text) {
  return parseDuration(text) ?? (/^\d+$/.test(text) ? Number(text) : null);
}

function listItemsIn(html, elements, container) {
  return elements
    .filter((element) => element.name === 'li' && contains(container, element))
    .filter((element, _, all) => !all.some((other) => other !== element && other.name === 'li' && contains(other, element)))
    .map((element) => cleanText(htmlToText(innerHtml(html, element), 2_000), 1_000))
    .filter(Boolean);
}

function pluginIngredients(html, elements, plugin) {
  if (plugin.listContainers) {
    const container = elementsWithClass(elements, plugin.listContainers.ingredients)[0];
    return container ? listItemsIn(html, elements, container).map((text) => ({ text, section: null })) : [];
  }
  const groups = elementsWithClass(elements, plugin.ingredientGroup);
  return elementsWithClass(elements, plugin.ingredientItem[0]).map((item) => {
    const group = groups.find((candidate) => contains(candidate, item));
    const heading = group ? elements.find((child) => contains(group, child) && (child.name === 'h4' || plugin.groupHeading.some((name) => hasClass(child, name)))) : null;
    return {
      text: cleanText(htmlToText(innerHtml(html, item), 2_000), 1_000),
      section: heading ? cleanText(htmlToText(innerHtml(html, heading), 300), 200) || null : null,
    };
  }).filter((entry) => entry.text);
}

function pluginInstructions(html, elements, plugin) {
  if (plugin.listContainers) {
    const container = elementsWithClass(elements, plugin.listContainers.instructions)[0];
    return container ? listItemsIn(html, elements, container) : [];
  }
  for (const className of plugin.instructionItem) {
    const items = elementsWithClass(elements, className);
    if (items.length) return items.map((item) => cleanText(htmlToText(innerHtml(html, item), 5_000), 5_000)).filter(Boolean);
  }
  return [];
}

export function detectRecipePlugin(html) {
  return RECIPE_PLUGINS.find((plugin) => new RegExp(`class=["'][^"']*\\b${plugin.title[0]}\\b`, 'i').test(String(html ?? '')))?.name ?? null;
}

export function extractPluginRecipe(html, sourceUrl, elements = scanElements(html)) {
  for (const plugin of RECIPE_PLUGINS) {
    const title = firstClassText(html, elements, plugin.title);
    if (!title) continue;
    const ingredients = pluginIngredients(html, elements, plugin);
    const instructions = pluginInstructions(html, elements, plugin);
    if (!ingredients.length && !instructions.length) continue;
    const draft = emptyDraft('url');
    draft.title = cleanText(title, 200);
    draft.description = cleanText(firstClassText(html, elements, plugin.summary), 2_000);
    draft.sourceURL = sourceUrl.href;
    draft.sourceName = sourceUrl.hostname.replace(/^www\./, '');
    draft.servings = parseServings(firstClassText(html, elements, plugin.servings));
    draft.prepTime = pluginMinutes(firstClassText(html, elements, plugin.prepTime));
    draft.cookTime = pluginMinutes(firstClassText(html, elements, plugin.cookTime));
    draft.totalTime = pluginMinutes(firstClassText(html, elements, plugin.totalTime))
      ?? (draft.prepTime != null && draft.cookTime != null ? draft.prepTime + draft.cookTime : null);
    draft.ingredients = ingredients.slice(0, 300).map(({ text, section }) => parseIngredient(text, section));
    draft.instructions = instructions.flatMap((text) => stepTexts(text)).slice(0, 200).map((text, index) => makeInstruction(text, index + 1));
    draft.notes = '';
    return { draft, plugin: plugin.name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const REJECTED_TITLES = new Set([
  'instagram', 'threads', 'facebook', 'tiktok', 'youtube', 'pinterest', 'twitter', 'x',
  'home', 'blog', 'recipes', 'recipe', 'untitled', 'menu', 'search', 'error', 'page not found',
  '404', 'loading', 'loading…', 'loading...', 'provecho', 'linktree',
]);
const WALL_TITLE = /^(?:log ?in|sign ?(?:in|up)|just a moment|attention required|access denied|pardon our interruption|please (?:enable|wait|verify)|are you a (?:human|robot)|verify (?:that )?you are|one more step|security check|checking your browser|robot or human|bot verification|request blocked|403 forbidden|cookie consent|we value your privacy)/i;
// Loose: any line that starts with a recipe-card label. Used to rank caption
// title candidates and staples, where a false positive costs nothing.
const META_LINE = /^(?:serves?|servings?|yield|yields|makes|prep(?: time)?|cook(?: time)?|total(?: time)?|time|ready in|calories|kcal|difficulty|level|course|cuisine)\b/i;
// Strict: a label followed by a value ("Serves 4", "Prep time: 10 minutes",
// "Course: Main"). Used wherever a false positive would drop a real step
// ("Serve immediately.", "Cook the chicken.") or reject a real title
// ("Time-Saving Pasta", "Level Up Lasagna").
const META_VALUE_LINE = /^(?:(?:serves?|servings?|yields?|makes|portions?)\s*[:：–—-]?\s*(?:about|approx\.?|approximately|~|up to)?\s*(?:\d|[¼⅓½⅔¾]|(?:one|two|three|four|five|six|eight|ten|twelve|a dozen)\b)|(?:prep|cook(?:ing)?|total|active|inactive|rest(?:ing)?|chill(?:ing)?|ready)\s*(?:time\s*[:：–—-]?|[:：–—-]|in)\s*(?:about|approx\.?|approximately|~)?\s*\d|time\s*[:：–—-]?\s*\d|(?:calories|kcal|cal)\s*[:：–—-]?\s*\d|\d[\d.,]*\s*(?:kcal|calories)\b|(?:difficulty|level|course|cuisine|category|keywords?|author|cost|diet|servings?|yield)\s*[:：]\s*\S|(?:difficulty|level)\s*[:：]?\s*(?:easy|medium|hard|beginner|intermediate|advanced|simple)\s*$)/i;
const SITE_SEPARATOR = /\s+(?:\||-|—|–|·|•|::|»)\s+/;

function tidyTitle(value) {
  return cleanText(value, 300)
    .replace(/^["“”'‘’«»\s]+|["“”'‘’«»\s]+$/g, '')
    .replace(/\s*[•·|]\s*\d(?:[.,]\d)?\s*★.*$/u, '')
    .replace(/[\s\p{Extended_Pictographic}\ufe0f\u200d!.:;,|~*#-]+$/u, '')
    .replace(/^[\p{Extended_Pictographic}\ufe0f\u200d\s*~-]+/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Imperative cooking verbs: a line that starts with one and reads like a
// sentence ("Brown it.", "Add the onions and cook until soft.") is a step.
const COOKING_VERBS = String.raw`(?:brown|heat|add|mix|stir|cook|bake|preheat|whisk|combine|pour|serve|season|chop|slice|dice|place|remove|let|cover|bring|reduce|simmer|boil|fry|saut[eé]|drain|transfer|sprinkle|garnish|melt|fold|toss|roast|grill|set|blend|knead|marinate|refrigerate|chill|cool|rest|repeat|top|spread|layer|arrange|flip|turn|cut|peel|grate|mince|crush|rinse|soak|steam|broil|microwave|assemble|fill|roll|wrap|press|squeeze|strain|mash|pur[ée]e|beat|cream|sift|scoop|divide|form|shape|seal|brush|coat|dredge|dip|sear|braise|poach|blanch|deglaze|thicken|taste|adjust|discard|return|continue|make|meanwhile|once|when|then|finally)`;
const IMPERATIVE_SENTENCE = new RegExp(String.raw`^${COOKING_VERBS}\b[^\n]*[.!]$`, 'i');
const IMPERATIVE_FRAGMENT = new RegExp(String.raw`^${COOKING_VERBS}\s+(?:it|them|this|that|the|a|an|your|until|for|in|on|over|with|well|together|everything|all|each|aside|to)\b`, 'i');
// "Brown it", "Mix well", "Set aside": a verb and a pronoun or adverb is a step
// even without a full stop, while "Roast the Chicken" can be a page title.
const PRONOUN_FRAGMENT = new RegExp(String.raw`^${COOKING_VERBS}\s+(?:it|them|this|that|everything|all|well|together|aside|until|thoroughly|gently|again)\b`, 'i');

function looksLikeInstructionLine(line) {
  const text = String(line ?? '').trim();
  return IMPERATIVE_SENTENCE.test(text) || (IMPERATIVE_FRAGMENT.test(text) && text.split(/\s+/).length <= 4);
}

/** The subset of instruction shapes that a page's own h1 or og:title can never legitimately take. */
function looksLikeInstructionSentence(line) {
  const text = String(line ?? '').trim();
  return IMPERATIVE_SENTENCE.test(text) || (PRONOUN_FRAGMENT.test(text) && text.split(/\s+/).length <= 3);
}

/**
 * Whether a candidate can be a recipe title. Candidates the page itself
 * declares (recipeName, h1, og:title, <title>) are judged leniently: they are
 * never steps or card fields, so "Roast the Chicken" and "Time-Saving Pasta"
 * pass. Caption lines and fallbacks are judged strictly.
 */
function acceptableTitle(value, lenient = false) {
  if (/^\s*(?:#\S+\s*)+$/.test(String(value ?? ''))) return false; // hashtag-only line
  if (lenient ? looksLikeInstructionSentence(value) : looksLikeInstructionLine(value)) return false;
  const title = tidyTitle(value);
  if (title.length < 3 || title.length > 200) return false;
  if (REJECTED_TITLES.has(title.toLowerCase())) return false;
  if (WALL_TITLE.test(title) || (lenient ? META_VALUE_LINE : META_LINE).test(title)) return false;
  if (lenient ? looksLikeInstructionSentence(title) : (IMPERATIVE_FRAGMENT.test(title) && title.split(/\s+/).length <= 4)) return false;
  if (/^(?:https?:\/\/|www\.)/i.test(title) || /\.[a-z]{2,}\/\S*$/i.test(title)) return false;
  if (/^[&?=]|[&?]\w+=/.test(title)) return false; // query-string fragments such as '&noscript=1'
  if (/^#/.test(title) || /^(?:#\S+\s*)+$/.test(title)) return false;
  if (/^@[\w.]+$/.test(title) || /\bon instagram\b/i.test(title)) return false;
  if (!/\p{L}{2}/u.test(title)) return false;
  if (/^(?:follow|save|share|comment|like|tag|subscribe|click|link in bio|dm me|view all)\b/i.test(title)) return false;
  return true;
}

/** "Pinch of Yum" → "pinchofyum", so a title part can be compared with og:site_name or the host name. */
function compactKey(value) {
  return String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Keys that identify the site in a document title: og:site_name and the host's labels ("pinchofyum.com" → "pinchofyum"). */
function siteNameKeys({ siteName = '', hostname = '' } = {}) {
  const keys = new Set();
  const site = compactKey(siteName);
  if (site.length >= 3) keys.add(site);
  const labels = String(hostname ?? '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length >= 2) {
    const named = labels.slice(0, -1);
    for (const label of named) if (label.length >= 4) keys.add(compactKey(label));
    keys.add(compactKey(named.join('')));
  }
  return keys;
}

/**
 * "Pot Roast - Pinch of Yum" → "Pot Roast": document and Open Graph titles
 * carry the site name as a suffix (occasionally a prefix). Parts equal to the
 * known site name are dropped and the first remaining part is the recipe, so
 * a long site name never outranks a short dish name.
 */
function stripSiteSuffix(value, site = new Set(), lenient = false) {
  const parts = tidyTitle(value).split(SITE_SEPARATOR).map(tidyTitle).filter((part) => acceptableTitle(part, lenient));
  if (!parts.length) return '';
  const remaining = parts.filter((part) => !site.has(compactKey(part)));
  return remaining[0] ?? '';
}

function finishTitle(value) {
  let title = tidyTitle(value).replace(/^instagram\s*[:|-]\s*/i, '');
  const social = title.match(/^(.+?)\s+on instagram\s*:\s*(.+)$/i);
  if (social) title = tidyTitle(social[2]);
  // "Lunches That Last, Episode 3: Chicken Caesar Wraps" → the dish, not the series label.
  const series = title.match(/^[^:]*\b(?:episode|ep\.?|part|day|vol(?:ume)?|series|week|no\.?)\s*\d+\s*[:\-–—]\s*(\S.*)$/i);
  if (series && series[1].split(/\s+/).length >= 2) title = tidyTitle(series[1]);
  const withoutRecipe = title.replace(/\s+recipe(?:\s+card)?$/i, '').replace(/^recipe\s*(?:for|:)\s*/i, '').trim();
  if (withoutRecipe.length >= 4 && /\p{L}/u.test(withoutRecipe) && withoutRecipe.split(/\s+/).length >= 1) title = withoutRecipe;
  return cleanText(title, 200);
}

/**
 * Picks a recipe title from, in order, structured data, the first content h1,
 * Open Graph and the document title (with site-name suffixes removed, using
 * `siteName` (og:site_name) and `hostname` to recognise the site), rejecting
 * placeholders such as "Instagram", URLs, hashtag lines, "serves 2" lines,
 * instructions and sign-in walls. Only the free-text `fallback` is held to the
 * strict caption rules; the page's own titles are never steps.
 */
export function pickRecipeTitle(candidates = {}) {
  const site = siteNameKeys(candidates);
  // Document and Open Graph titles usually carry a site-name suffix, so try them stripped first.
  const ordered = [
    [candidates.recipeName, false, true], [candidates.h1, false, true], [candidates.ogTitle, true, true],
    [candidates.pageTitle, true, true], [candidates.fallback, true, false],
  ];
  for (const [candidate, documentTitle, lenient] of ordered) {
    if (!candidate) continue;
    const attempts = [finishTitle(candidate), finishTitle(stripSiteSuffix(candidate, site, lenient))];
    if (documentTitle) attempts.reverse();
    const title = attempts.find((attempt) => attempt && acceptableTitle(attempt, lenient) && !site.has(compactKey(attempt)));
    if (title) return title;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Caption / free-text recipe parser
// ---------------------------------------------------------------------------

// Heading phrases as [pattern, inline]. Inline phrases are also recognised in
// the middle of a line ("Dinner sorted! Ingredients: 2 eggs…"); the others are
// too common in prose ("prep", "recipe") and only count on a line of their own.
const INGREDIENT_HEADINGS = [
  ['ingredients?', true], ['ingredient list', true], ["what you(?:'|’)?ll need", true], ['what you need', true],
  ["you(?:'|’)?ll need", true], ['you will need', true], ['shopping list', true], ['grocery list', true],
  ['for the recipe', false], ['recipe', false],
];
const INSTRUCTION_HEADINGS = [
  ['directions?', true], ['instructions?', true], ['methods?', true], ['preparation', true], ['steps?', true],
  ['how to make(?: it| this)?', true], ['to make', true], ['assembly', true], ['process', true], ['procedure', true],
  ['prep', false], ['how to', false], ['to prepare', false], ["let(?:'|’)?s (?:make it|cook|get cooking)", false],
  ["here(?:'|’)?s how", false], ['the method', false], ['what to do', false], ['cooking instructions', false], ['cooking method', false], ['make it', false],
];
const headingAlternatives = (entries, inlineOnly = false) => entries
  .filter(([, inline]) => inline || !inlineOnly)
  .map(([pattern]) => pattern)
  .join('|');
const INGREDIENT_HEADING = new RegExp(`^(?:${headingAlternatives(INGREDIENT_HEADINGS)})$`, 'i');
const INSTRUCTION_HEADING = new RegExp(`^(?:${headingAlternatives(INSTRUCTION_HEADINGS)})$`, 'i');
const HEADING_WORDS = headingAlternatives([...INGREDIENT_HEADINGS, ...INSTRUCTION_HEADINGS], true);
const HEADING_QUALIFIER = new RegExp(`^(?:${headingAlternatives([...INGREDIENT_HEADINGS, ...INSTRUCTION_HEADINGS])})\\s+(?:for\\s+)?(?:the\\s+)?(\\S.*)$`, 'i');
const SOCIAL_LINE = /^(?:follow|comment|share|save|tag|enjoy|shop|like|subscribe|dm|credit|credits|music|song|video|recipe by|inspired by|link in (?:my )?bio|full (?:recipe|notes|video)|recipe (?:link|at|in|on|below)|more (?:details|at|recipes)|see more|watch|click|swipe|double tap|let me know|tried this|if you (?:make|try|like|love)|happy cooking|bon app[ée]tit|xoxo|xx|love,|thanks? for|thank you)\b|^(?:#|@|https?:\/\/|www\.)/i;
const SECTION_LINE = /^(?:for the\s+)?[\p{L}][\p{L}\p{N} &/'’()-]{1,60}:$/u;
const FOR_THE_SECTION = /^for the\s+[\p{L}][\p{L}\p{N} &/'’-]{1,60}$/iu;
// Recipe-card chrome that starts with a number and would otherwise pass as an
// ingredient: "5 from 12 votes", "4.8 out of 5", "★★★★★ 12 reviews".
const RATING_LINE = /^(?:\d+(?:[.,]\d+)?\s*(?:\/\s*5|out of 5|stars?|★+)\b.*|\d+(?:[.,]\d+)?\s+from\s+\d[\d,]*\s*(?:votes?|reviews?|ratings?)?|(?:no|\d[\d,]*)\s+(?:votes?|reviews?|ratings?|comments?)(?:\s+yet)?|★+(?:\s*\d+(?:[.,]\d+)?)?|rate this recipe!?|print(?: recipe)?|pin(?: recipe| it)?|jump to (?:recipe|video)|save recipe|share|email|tweet)$/i;
// Headings that end the method. Notes-like sections are kept as recipe notes;
// nutrition, video, FAQ, comments and "related" rails are dropped. "To serve:"
// and "Serve with:" are deliberately absent: in captions they head an
// ingredient group ("To serve: lime wedges, cilantro"), which SECTION_LINE handles.
const NOTES_HEADING = /^(?:(?:recipe|chef'?s?|cook'?s?|my|helpful|pro|expert|quick|top) )?(?:notes?|tips?(?: (?:and|&) tricks)?|hints?|variations?|substitutions?|storage(?: (?:and|&) reheating| instructions| tips)?|how to store|leftovers|make[- ]ahead|equipment|serving suggestions?)$/i;
const DROP_HEADING = /^(?:nutrition(?: facts| information| info)?|nutritional information|video|watch the video|recipe video|faqs?|frequently asked questions|comments?|leave a (?:comment|reply)|reviews?|rate this recipe|did you make this recipe|you might also like|you may also like|related(?: recipes| posts| articles)?|more recipes|similar recipes|recommended|popular recipes|trending|about the author|about me|share this recipe|print recipe|jump to recipe)$/i;

/** "Notes", "Nutrition Facts:", "You might also like" → the kind of section a heading opens, or null. */
function terminatorKind(line) {
  const heading = line.trim()
    .replace(/^[-–—•*▪◦👉👇⬇✨🔥🥘🍴🧾📝\s]+/u, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s*[:：].*$/, '')
    .replace(/[^\p{L}\p{N}'’&-]+$/gu, '')
    .trim();
  if (!heading || heading.split(/\s+/).length > 6) return null;
  if (NOTES_HEADING.test(heading)) return 'notes';
  if (DROP_HEADING.test(heading)) return 'dropped';
  return null;
}

// Unquantified lines that are still ingredients when they sit among quantified
// ones: "Salt", "Pepper", "Spray oil", "Lime wedges", "Fresh parsley for garnish".
const STAPLE_LINE = /^(?:(?:sea|kosher|flaky|fine|coarse|black|white|fresh|freshly ground|ground|cracked|spray|cooking|olive|vegetable|neutral|avocado|sesame|coconut|canola|extra[- ]virgin|unsalted|salted|chopped|minced|grated|shredded|crushed|hot|cold|warm|toasted|flat[- ]leaf|red|green|yellow)\s+)*(?:salt|pepper|salt (?:and|&) pepper|oil|spray|butter|water|ice|sugar|flour|lime wedges?|lemon wedges?|lemons?|limes?|parsley|cilantro|coriander|basil|chives|mint|dill|herbs|scallions?|green onions?|spring onions?|sesame seeds?|hot sauce|sour cream|yogh?urt|cheese|parmesan|feta|rice|tortillas?|bread|lettuce|avocado|honey|lemon juice|lime juice|garlic|ginger|onion|cooking spray|nonstick spray|chil(?:i|li) flakes|red pepper flakes|pepper flakes)(?:\s*,?\s*(?:to taste|as needed|for (?:garnish|serving|topping|drizzling|greasing|frying)|optional|to serve))?$/i;

function isStapleCandidate(line) {
  if (line.length > 50 || line.split(/\s+/).length > 5) return false;
  if (isCaptionChatter(line) || META_LINE.test(line) || RATING_LINE.test(line) || headingKind(line) || terminatorKind(line) || looksLikeInstructionLine(line)) return false;
  if (STAPLE_LINE.test(line)) return true;
  return /^[\p{L}][\p{L}\s&'’-]*$/u.test(line)
    && !/^(?:enjoy|yum|delicious|so good|love|thanks?|note|notes|tips?|serve|serves|makes|optional|total|prep|cook|and|or|the|this|that|my|i|we|you|it|its|it's|a|an)\b/i.test(line);
}

// "1/2 inch dice", "2-inch pieces", "1 cm slices": a size clause after a comma, not a second ingredient.
const SIZE_CLAUSE = /^(?:\d+(?:[.,/]\d+)?|[¼⅓½⅔¾⅛⅜⅝⅞])(?:\s*(?:-|–|to)\s*(?:\d+(?:[.,/]\d+)?|[¼⅓½⅔¾⅛⅜⅝⅞]))?\s*-?\s*(?:inch(?:es)?|in|cm|mm|"|″)(?![a-z])/i;

/**
 * "2 eggs, 1 cup flour, 1 tsp salt" on one line under an Ingredients heading.
 * A line splits when it holds three or more quantified parts, or two when it
 * is the only line of its block; "1 onion, 1/2 inch dice" never splits.
 */
function splitCommaIngredients(line, blockIsEmpty = false) {
  if (!line.includes(',')) return [line];
  const parts = line.split(/,\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || (parts.length < 3 && !blockIsEmpty)) return [line];
  const quantified = (part) => (QUANTITY_PREFIX.test(part) || RANGE_PREFIX.test(part)) && !SIZE_CLAUSE.test(part);
  return parts.every(quantified) ? parts : [line];
}

function normalizeRecipeText(value) {
  return cleanText(value, 75_000)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*)/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/([0-9])\ufe0f?\u20e3/g, '\n$1.')
    .replace(/[•●▪▫◦]\s*/g, '\n• ')
    // An inline heading ("Dinner sorted! Ingredients: …") starts its own line, unless the
    // keyword is the tail of a longer phrase ("How to make:", "What you need:").
    .replace(new RegExp(`(?<!\\b(?:how|ready|easy|want|going|need|love|time|way|about|what))\\s+(?=(?:${HEADING_WORDS})\\s*(?:\\([^)]*\\))?\\s*[:：]|(?:${HEADING_WORDS})\\s*[👇⬇⤵])`, 'gi'), '\n')
    .replace(new RegExp(`\\b((?:${HEADING_WORDS}))\\s*(\\([^)]*\\))?\\s*[:：]\\s*`, 'gi'), '$1 $2\n')
    .replace(/;\s+(?=(?:\d|[¼⅓½⅔¾⅛⅜⅝⅞]))/g, '\n')
    .replace(/\s+(?=\d{1,2}[.)]\s+[A-Z])/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeIngredient(line) {
  const text = line.replace(/^(?:[-–—•*▪◦]\s*)/, '');
  return QUANTITY_PREFIX.test(text) || RANGE_PREFIX.test(text)
    || /^(?:salt|pepper|water|oil|salt and pepper|salt & pepper|olive oil)\s*(?:,|to taste|as needed|$)/i.test(text)
    || WORD_QUANTITY.test(text);
}

function headingKind(line) {
  const heading = line.trim()
    .replace(/^[-–—•*▪◦👉👇⬇✨🔥🥘🍴🧾📝\s]+/u, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s*[:：]\s*(?:serves?|makes|yield).*$/i, '')
    .replace(/[^\p{L}'’]+$/gu, '')
    .trim();
  if (INGREDIENT_HEADING.test(heading)) return 'ingredients';
  if (INSTRUCTION_HEADING.test(heading)) return 'instructions';
  const words = heading.split(/\s+/).length;
  // "Ingredients for the salad", "Step-By-Step Recipe Method", "How To Make Nana's Salad":
  // short headings built around the keyword.
  if (words <= 8 && /^ingredients?\b/i.test(heading) && !looksLikeIngredient(heading)) return 'ingredients';
  if (words <= 6 && /\b(?:method|directions?|instructions?)$/i.test(heading) && !/\b(?:in|on|below|above|see)\b/i.test(heading)) return 'instructions';
  if (words <= 10 && /^(?:how to (?:make|cook|prepare|assemble)|directions? for|instructions? for|method for)\b/i.test(heading)) return 'instructions';
  return null;
}

/** "Ingredients for the dressing" → "dressing"; a bare heading → null. */
function headingQualifier(line) {
  const heading = line.trim().replace(/^[-–—•*▪◦\s]+/u, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/[^\p{L}\p{N}'’]+$/gu, '');
  const match = heading.match(HEADING_QUALIFIER);
  const qualifier = match ? cleanText(match[1], 200) : '';
  return qualifier && !/^(?:it|this|them)$/i.test(qualifier) ? qualifier : null;
}

function isCaptionChatter(line) {
  return SOCIAL_LINE.test(line)
    || (/https?:\/\/\S+|\bwww\.\S+/i.test(line) && line.split(/\s+/).length <= 8)
    || (/\b(?:instagram|facebook|pinterest|tiktok|youtube|app store|open in (?:the )?app|download|sign up|log in)\b/i.test(line) && line.split(/\s+/).length <= 6)
    || /^(?:method|recipe|instructions|directions|full recipe|ingredients)\b.*\b(?:in|on|below|caption|bio|comments|pinned|app|blog|website)\b/i.test(line)
    || /^(?:save this|save for later|make sure to|don(?:'|’)t forget)/i.test(line);
}

function titleCandidates(lines) {
  const ingredientHeading = lines.findIndex((line) => headingKind(line) === 'ingredients');
  const preamble = lines.slice(0, ingredientHeading >= 0 ? ingredientHeading : Math.min(lines.length, 8))
    .filter((line) => !headingKind(line) && !looksLikeIngredient(line) && !isCaptionChatter(line) && !META_LINE.test(line) && !looksLikeInstructionLine(line));
  const uppercaseTitle = [...preamble].reverse().find((line) => {
    const letters = line.replace(/[^\p{L}]/gu, '');
    const words = line.split(/\s+/).length;
    return letters.length >= 4 && words >= 2 && words <= 12 && line.length <= 120 && letters === letters.toLocaleUpperCase();
  });
  const slashTitle = [...preamble].reverse().map((line) => ({ line, candidate: line.split(/\s*[/|]\s*/)[0].trim() }))
    .find(({ line, candidate }) => line !== candidate && candidate.length >= 4 && candidate.length <= 100
      && candidate.split(/\s+/).length <= 12 && !/[.!?]$/.test(candidate))?.candidate;
  const colonTitle = preamble.map((line) => line.match(/^([^:]{4,80}):\s+\S/)?.[1]).find(Boolean);
  // Lines after the first heading are ingredients or steps, never titles.
  const firstHeading = lines.findIndex((line) => headingKind(line));
  const rest = lines.slice(0, firstHeading >= 0 ? firstHeading : lines.length)
    .filter((line) => !looksLikeIngredient(line) && !isCaptionChatter(line) && !META_LINE.test(line) && !looksLikeInstructionLine(line));
  return unique([uppercaseTitle, slashTitle, ...preamble, colonTitle, ...rest]);
}

function titleFromCaption(caption, preferredTitle = '', hostname = '') {
  const lines = normalizeRecipeText(caption).split('\n').map((line) => line.replace(/^[-–—•*]\s*/, '').trim()).filter(Boolean);
  for (const candidate of titleCandidates(lines)) {
    const sentence = candidate.length > 140 ? candidate.split(/(?<=[.!?])\s+/)[0] : candidate;
    const title = finishTitle(sentence.replace(/^save (?:this|for later)[:!\s-]*/i, '').replace(/[.!?]+$/, ''));
    if (acceptableTitle(title) && title.length <= 160) return title;
  }
  return pickRecipeTitle({ pageTitle: preferredTitle, hostname });
}

function timeField(normalized, label) {
  return parseDuration(normalized.match(new RegExp(`\\b${label}(?:\\s+time)?\\s*[:–-]?\\s*([^\\n]+)`, 'i'))?.[1]);
}

function safeHostname(value) {
  try { return new URL(String(value ?? '')).hostname; } catch { return ''; }
}

export function parseRecipeCaption(caption, options = {}) {
  const normalized = normalizeRecipeText(caption);
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const draft = emptyDraft('url');
  draft.title = titleFromCaption(normalized, options.title, safeHostname(options.sourceURL));
  draft.sourceURL = options.sourceURL ?? null;
  draft.sourceName = options.sourceName ?? 'Instagram';
  draft.author = options.author ?? null;
  draft.heroImage = safeDisplayImage(options.heroImage);
  draft.servings = Number(normalized.match(/\b(?:serves?|servings?|yield|makes)\s*[:–-]?\s*(\d+)/i)?.[1] ?? '') || null;
  draft.prepTime = timeField(normalized, 'prep');
  draft.cookTime = timeField(normalized, 'cook');
  draft.totalTime = timeField(normalized, 'total')
    ?? (draft.prepTime != null && draft.cookTime != null ? draft.prepTime + draft.cookTime : null);
  draft.tags = unique([...normalized.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1].toLowerCase())).slice(0, 30);

  // Ingredient lines are grouped into blocks, one per bare "Ingredients" heading
  // (or one implicit block when quantities appear without a heading). Blog pages
  // often repeat the list in prose and again in a print card; the block with the
  // most quantity-like lines is the real one.
  let mode = 'meta';
  let block = null;
  const blocks = [];
  let ingredientSection = null;
  let instructionSection = null;
  let instructionsAtHeading = -1;
  let terminatorAt = -1;
  const numberedSteps = new Set();
  const unquantified = new WeakSet();
  const descriptionLines = [];
  const notesLines = [];
  let notesLength = 0;
  const startBlock = (explicit) => { block = { explicit, items: [] }; blocks.push(block); };
  const ORDINAL = /^(?:step\s*\d+\s*[:.)-]?|\d{1,2}[.)])\s+/i;
  const ordinalOf = (line) => Number(line.match(/^(?:step\s*)?(\d{1,2})/i)?.[1]);

  lines.forEach((originalLine, lineIndex) => {
    let line = originalLine.replace(/^[-–—•*▪◦+]\s*/, '').trim();
    const kind = headingKind(line);
    if (kind === 'ingredients') {
      mode = 'ingredients';
      const qualifier = headingQualifier(line);
      if (!qualifier || !block?.explicit) startBlock(true);
      ingredientSection = qualifier;
      return;
    }
    if (kind === 'instructions') {
      mode = 'instructions';
      instructionSection = headingQualifier(line);
      if (instructionsAtHeading < 0) instructionsAtHeading = draft.instructions.length;
      return;
    }
    // "Notes", "Nutrition", "Comments": the method is over. "Notes: keep chilled." carries its first note inline.
    const terminator = terminatorKind(line);
    if (terminator && mode !== 'meta') {
      mode = terminator;
      if (terminatorAt < 0) terminatorAt = lineIndex;
      line = line.match(/^[^:：]+[:：]\s*(\S.*)$/)?.[1]?.trim() ?? '';
      if (!line) return;
    }
    if (!line || /^https?:\/\//i.test(line) || /^(?:#\S+\s*)+$/u.test(line)) return;
    if (RATING_LINE.test(line)) return;
    // "Serves 4", "Prep time: 10 minutes" are card fields; "Serve immediately." and "Cook the chicken." are steps.
    if (META_VALUE_LINE.test(line) && !looksLikeIngredient(line)) return;

    // "1. 1 loaf bread" is still an ingredient; the ordinal belongs to the list.
    const numbered = ORDINAL.test(line);
    const unnumbered = numbered ? line.replace(ORDINAL, '').trim() : line;
    if (mode === 'meta') {
      // A bare quantity opens the implicit ingredient block. A numbered one does
      // so only when it starts a list of them ("1. 1 loaf bread" then "2. 2 tbsp
      // butter"), because "1. 2 minutes later, flip" is a step.
      const next = (lines[lineIndex + 1] ?? '').replace(/^[-–—•*▪◦+]\s*/, '');
      const opensList = numbered && ordinalOf(line) === 1 && looksLikeIngredient(unnumbered)
        && ORDINAL.test(next) && looksLikeIngredient(next.replace(ORDINAL, '').trim());
      if ((!numbered && looksLikeIngredient(line)) || opensList) { mode = 'ingredients'; startBlock(false); }
    }
    if (mode === 'ingredients' && numbered && !looksLikeIngredient(unnumbered)) {
      // "4. Fresh parsley for garnish" continuing a numbered list of ingredients is not the first step.
      const continuesList = block && block.items.length >= 2 && ordinalOf(line) === block.items.length + 1 && STAPLE_LINE.test(unnumbered);
      if (!continuesList) mode = 'instructions';
    }

    if (mode === 'ingredients') {
      // "For the salad" + a down-arrow emoji, "Dressing:" name the group the following lines belong to.
      const sectionLine = line.replace(/[\s\p{Extended_Pictographic}\ufe0f\u200d\u{1F447}\u2B07\u2935]+$/u, '').trim();
      if ((SECTION_LINE.test(sectionLine) || FOR_THE_SECTION.test(sectionLine)) && !looksLikeIngredient(line)) {
        ingredientSection = cleanText(sectionLine.replace(/:$/, ''), 200);
        return;
      }
      // "Serve with: 2 limes, 1 cup rice", "Dressing: 2 tbsp oil, 1 lemon": a group heading with its items inline.
      const inlineGroup = line.match(/^([\p{L}][\p{L}\p{N} &/'’()-]{1,40}):\s+(\S.*)$/u);
      if (inlineGroup && !looksLikeIngredient(line) && looksLikeIngredient(inlineGroup[2]) && !headingKind(inlineGroup[1])) {
        const label = cleanText(inlineGroup[1], 200);
        const optionalGroup = /^optional$/i.test(label);
        if (!optionalGroup) ingredientSection = label;
        for (const part of splitCommaIngredients(inlineGroup[2], true)) block.items.push(parseIngredient(optionalGroup ? `${part}, optional` : part, ingredientSection));
        return;
      }
      // Prose under an ingredients heading ("Optional: this salad is great with…") is not an ingredient.
      if (isCaptionChatter(line) || (!looksLikeIngredient(unnumbered) && (line.length > 140 || line.split(/\s+/).length > 12))) return;
      const quantified = looksLikeIngredient(unnumbered);
      if (block.explicit || quantified) {
        for (const part of splitCommaIngredients(unnumbered, block.items.length === 0)) block.items.push(parseIngredient(part, ingredientSection));
      } else if (isStapleCandidate(unnumbered)) {
        const staple = parseIngredient(unnumbered, ingredientSection);
        unquantified.add(staple);
        block.items.push(staple);
      }
    } else if (mode === 'instructions') {
      line = unnumbered;
      if (SECTION_LINE.test(line) || FOR_THE_SECTION.test(line)) { instructionSection = cleanText(line.replace(/:$/, ''), 200); return; }
      if (!line || isCaptionChatter(line) || /^(?:enjoy|yum|delicious|so good|that(?:'|’)s it)\b/i.test(line)) return;
      const step = makeInstruction(line, draft.instructions.length + 1, instructionSection);
      if (numbered) numberedSteps.add(step.id);
      draft.instructions.push(step);
    } else if (mode === 'notes') {
      if (isCaptionChatter(line) || notesLength >= MAX_NOTES_CHARS) return;
      notesLines.push(line);
      notesLength += line.length + 1;
    } else if (mode === 'dropped') {
      // Nutrition tables, comments, related-recipe rails: never recipe content.
    } else if (line !== draft.title && descriptionLines.length < 3 && !isCaptionChatter(line)) {
      descriptionLines.push(line);
    }
  });

  const explicitBlocks = blocks.filter((candidate) => candidate.explicit);
  const sawIngredientHeading = explicitBlocks.length > 0;
  const sawInstructionHeading = instructionsAtHeading >= 0;
  const quantityCount = (candidate) => candidate.items.filter((item) => !unquantified.has(item)).length;
  draft.ingredients = (explicitBlocks.length ? explicitBlocks : blocks)
    .sort((left, right) => quantityCount(right) - quantityCount(left))[0]?.items ?? [];
  // Steps collected before an explicit heading were prose that merely began with a number.
  if (sawInstructionHeading) draft.instructions = draft.instructions.slice(instructionsAtHeading);

  // Without an explicit instruction heading, accept only clearly numbered directions (and none from past a terminator).
  if (!sawInstructionHeading && !draft.instructions.length) {
    draft.instructions = lines.slice(0, terminatorAt >= 0 ? terminatorAt : lines.length)
      .filter((line) => /^\d{1,2}[.)]\s+/.test(line) && !looksLikeIngredient(line.replace(ORDINAL, '')))
      .slice(0, 100)
      .map((line, index) => makeInstruction(line.replace(/^\d{1,2}[.)]\s*/, ''), index + 1));
  }
  // When some steps are numbered, the unnumbered paragraphs around them are commentary.
  const numberedOnly = draft.instructions.filter((step) => numberedSteps.has(step.id));
  if (numberedOnly.length >= 2 && numberedOnly.length < draft.instructions.length) draft.instructions = numberedOnly;

  // A heading is evidence that unquantified ingredient lines are intentional.
  // Without one, an unquantified staple is kept only in the company of
  // quantified lines: after an accepted line and before another, or when it
  // is a recognisable staple ("Salt", "Lime wedges", "Fresh parsley for garnish").
  if (!sawIngredientHeading) {
    const kept = [];
    draft.ingredients.forEach((ingredient, index, items) => {
      if (!unquantified.has(ingredient)) { kept.push(ingredient); return; }
      const previousKept = index > 0 && kept[kept.length - 1] === items[index - 1];
      const next = items[index + 1];
      const nextQuantified = Boolean(next) && !unquantified.has(next);
      if (previousKept && (nextQuantified || STAPLE_LINE.test(ingredient.rawText))) kept.push(ingredient);
    });
    draft.ingredients = kept;
  }
  draft.ingredients = uniqueBy(draft.ingredients, (ingredient) => `${ingredient.section ?? ''}|${normalizeName(ingredient.rawText)}`).slice(0, CLIENT_LIMITS.ingredients);
  draft.instructions = uniqueBy(draft.instructions, (step) => normalizeName(step.text)).slice(0, CLIENT_LIMITS.instructions)
    .map((step, index) => ({ ...step, stepNumber: index + 1 }));
  draft.description = cleanText(descriptionLines.join('\n'), 2_000);
  draft.notes = cleanText(notesLines.join('\n'), MAX_NOTES_CHARS);
  return draft;
}

// ---------------------------------------------------------------------------
// Links discovered in captions and pages
// ---------------------------------------------------------------------------

function unwrapRedirect(url) {
  const host = url.hostname.toLowerCase();
  const isWrapper = (isInstagramHost(host) || hostMatchesDomain(host, 'facebook.com')) && /(?:^|\/)(?:l\.php|linkshim)/i.test(url.pathname);
  if (!isWrapper && host !== 'l.instagram.com' && host !== 'l.facebook.com') return url;
  const destination = url.searchParams.get('u') ?? url.searchParams.get('url');
  if (!destination) return url;
  try { return new URL(destination); } catch { return url; }
}

function isLikelyRelatedUrl(url, sourceUrl) {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  if (url.href === sourceUrl.href) return false;
  const host = url.hostname.toLowerCase();
  if (hostInDomainList(host, NON_RECIPE_DOMAINS) || hostInDomainList(host, CRAWL_BLOCKLIST_DOMAINS)) return false;
  if (/\.(?:jpe?g|png|gif|webp|svg|mp4|mov|m3u8|css|js|woff2?|pdf|zip)(?:$|\?)/i.test(url.pathname)) return false;
  return true;
}

function urlsFromText(value) {
  const decoded = decodeHtmlEntities(String(value ?? ''));
  const results = [];
  for (const match of decoded.matchAll(/https?:\/\/[^\s<>"'\]]+/gi)) {
    let raw = match[0].replace(/[),.;!?:]+$/, '');
    // Markdown URLs retain a final parenthesis only when it balances a parenthesis in the URL.
    if ((raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) raw = raw.replace(/\)+$/, '');
    try { results.push(unwrapRedirect(new URL(raw))); } catch { /* Ignore malformed text URLs. */ }
  }
  return results;
}

function extractPageLinks(html, sourceUrl, elements = scanElements(html)) {
  const links = [];
  for (const element of elements) {
    if (element.name !== 'a' || !element.attrs.href || links.length >= 200) continue;
    try {
      const url = unwrapRedirect(new URL(element.attrs.href, sourceUrl));
      if (isLikelyRelatedUrl(url, sourceUrl)) links.push(url);
    } catch { /* Ignore malformed page links. */ }
  }
  return unique(links.map((url) => url.href)).map((url) => new URL(url));
}

function recipeTitleTokens(title) {
  return unique(normalizeName(title).split(' ')).filter((word) => word.length >= 3 && !TITLE_STOPWORDS.has(word));
}

// Order candidate pages so the crawl budget is spent on the pages most likely
// to hold this recipe: slugs matching the caption title, then recipe-ish URLs
// and link-in-bio hubs, with obvious non-recipe pages (about, shop, …) last.
export function rankRelatedUrls(urls, titleTokens = []) {
  return urls
    .map((url, index) => {
      let slug;
      try { slug = decodeURIComponent(url.pathname); } catch { slug = url.pathname; }
      slug = normalizeName(slug.replace(/[^\p{L}\p{N}]+/gu, ' '));
      let score = 0;
      for (const token of titleTokens) if (slug.includes(token)) score += 5;
      if (/\brecipes?\b/.test(`${slug} ${url.hostname.toLowerCase()}`)) score += 2;
      if (isLinkHubUrl(url)) score += 3;
      if (NON_RECIPE_PATH_PATTERN.test(url.pathname)) score -= 6;
      return { url, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.url);
}

// ---------------------------------------------------------------------------
// Instagram: public embed page
// ---------------------------------------------------------------------------

export function instagramShortcode(url) {
  const match = url.pathname.match(/^\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]{5,40})(?:\/|$)/);
  return match ? match[1] : null;
}

function instagramEmbedUrl(shortcode) {
  return new URL(`https://www.instagram.com/p/${shortcode}/embed/captioned/`);
}

const EMBED_MISS_MARKERS = /post isn(?:'|’|&#39;|&#x27;)?t available|sorry, this page isn(?:'|’|&#39;|&#x27;)?t available|this post is unavailable|content unavailable|log in to (?:see|view)|login_required|embedisbroken|EmbedIsBroken/i;

/** Reads a JSON string literal starting at html[index] === '"' and returns its decoded value. */
function readJsonString(text, index) {
  let cursor = index + 1;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === 92) { cursor += 2; continue; } // backslash escape
    if (code === 34) break;
    cursor += 1;
  }
  try { return JSON.parse(text.slice(index, cursor + 1)); } catch { return ''; }
}

function captionFromContextJson(html) {
  const marker = html.indexOf('contextJSON');
  if (marker < 0) return { caption: '', creator: null };
  const quote = html.indexOf('"', html.indexOf(':', marker) + 1);
  if (quote < 0) return { caption: '', creator: null };
  const context = readJsonString(html, quote);
  let caption = '';
  let creator = null;
  try {
    const media = JSON.parse(context)?.gql_data?.shortcode_media;
    caption = firstText(media?.edge_media_to_caption?.edges?.[0]?.node?.text);
    creator = cleanText(media?.owner?.username ?? '', 60) || null;
  } catch { /* Fall through to the targeted scan. */ }
  if (!caption) {
    const textIndex = context.indexOf('"text":"', context.indexOf('edge_media_to_caption'));
    if (textIndex >= 0) caption = cleanText(readJsonString(context, textIndex + 7), 75_000);
  }
  if (!creator) creator = context.match(/"owner":\{[^}]*?"username":"([\w.]{1,60})"/)?.[1] ?? null;
  return { caption: cleanText(caption, 75_000), creator };
}

function captionFromEmbedMarkup(html, elements) {
  const captionElement = elements.find((element) => element.name === 'div' && hasClass(element, 'caption'));
  if (!captionElement) return { caption: '', creator: null };
  let markup = innerHtml(html, captionElement);
  const creator = markup.match(/class=["']CaptionUsername["'][^>]*>([^<]{1,60})</i)?.[1]
    ?? html.match(/class=["']UsernameText["'][^>]*>([^<]{1,60})</i)?.[1] ?? null;
  markup = markup.replace(/^\s*<a\b[^>]*class=["']CaptionUsername["'][\s\S]*?<\/a>/i, '');
  const comments = elements.find((element) => hasClass(element, 'captioncomments') && contains(captionElement, element));
  if (comments) markup = markup.slice(0, comments.start - captionElement.contentStart);
  const caption = htmlToText(markup, 75_000)
    .split('\n')
    .filter((line) => !/^view (?:all|more)(?: \d[\d,]*)? comments?$/i.test(line.trim()))
    .join('\n');
  return { caption: cleanText(caption, 75_000), creator: creator ? cleanText(creator, 60) : null };
}

/**
 * Parses https://www.instagram.com/p/<shortcode>/embed/captioned/. Returns
 * null when the page carries no caption (private, removed or login-gated).
 */
export function parseInstagramEmbed(html, sourceUrlValue) {
  const source = String(html ?? '');
  const elements = scanElements(source);
  const markup = captionFromEmbedMarkup(source, elements);
  const context = captionFromContextJson(source);
  if (!markup.caption && !context.caption) return null;
  if (!markup.caption && EMBED_MISS_MARKERS.test(source)) return null;
  const caption = [markup.caption, context.caption].filter(Boolean).sort((left, right) => {
    const evidence = recipeEvidenceScore(parseRecipeCaption(right)) - recipeEvidenceScore(parseRecipeCaption(left));
    return evidence || right.length - left.length;
  })[0];
  const creator = markup.creator ?? context.creator;
  const sourceUrl = normalizeSourceUrl(sourceUrlValue);
  const relatedUrls = unique(urlsFromText(caption).filter((url) => isLikelyRelatedUrl(url, sourceUrl)).map((url) => url.href)).map((url) => new URL(url));
  return { caption, creator, title: '', heroImage: null, relatedUrls };
}

// ---------------------------------------------------------------------------
// Instagram: Jina Reader fallback
// ---------------------------------------------------------------------------

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

function creatorFromReader(description, content) {
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
  const creator = creatorFromReader(description, content);
  const captionCandidates = unique([captionFromDescription(description), captionFromReaderMarkdown(content, creator)]);
  const caption = captionCandidates.sort((left, right) => {
    const evidenceDifference = recipeEvidenceScore(parseRecipeCaption(right)) - recipeEvidenceScore(parseRecipeCaption(left));
    return evidenceDifference || right.length - left.length;
  })[0] ?? '';
  const title = metadataValue(metadata, 'og:title', 'title') || firstText(data.title);
  const heroImage = metadataValue(metadata, 'og:image', 'twitter:image', 'image');
  const sourceUrl = normalizeSourceUrl(sourceUrlValue);
  const sourceSegments = sourceUrl.pathname.split('/').filter(Boolean);
  const isProfilePage = sourceSegments.length === 1 && !/^(?:reel|reels|p|tv|explore|accounts|stories)$/i.test(sourceSegments[0]);
  // Reader markdown can include commenter profiles, recommended posts and Meta
  // boilerplate. Only caption URLs are eligible crawl targets for a post import.
  // A creator profile may expose its external website only in the markdown.
  const relatedText = isProfilePage ? `${caption}\n${content}` : caption;
  const relatedUrls = unique(urlsFromText(relatedText).filter((url) => isLikelyRelatedUrl(url, sourceUrl)).map((url) => url.href)).map((url) => new URL(url));
  return { caption, creator, title, heroImage, relatedUrls, content, metadata };
}

/** Markdown returned by the reader for an ordinary (client-rendered) web page. */
function readerPageText(payload) {
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    return { content: cleanText(data?.content, 100_000), title: firstText(data?.title), ogTitle: metadataValue(data?.metadata, 'og:title') };
  } catch {
    return { content: cleanText(payload, 100_000), title: '', ogTitle: '' };
  }
}

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------

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

// Node 20+ spells the "answers in resolver order" option `order: 'verbatim'`;
// the older `verbatim: true` is kept as a fallback for runtimes that reject it.
async function lookupAll(resolver, hostname) {
  try {
    return await resolver(hostname, { all: true, order: 'verbatim' });
  } catch (error) {
    if (error?.code === 'ERR_INVALID_ARG_VALUE' || error?.code === 'ERR_INVALID_ARG_TYPE') return resolver(hostname, { all: true, verbatim: true });
    throw error;
  }
}

async function resolvePublicAddress(url, resolver = dnsLookup, timeoutMs = 5_000) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  let timer;
  let answers;
  try {
    answers = await Promise.race([
      lookupAll(resolver, hostname),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(answers) || !answers.length) throw new Error('URL hostname did not resolve.');
  if (answers.some((answer) => !isPublicIpAddress(answer.address))) throw new Error('URL hostname resolved to a non-public address.');
  return answers;
}

export function normalizeSourceUrl(raw) {
  const url = validateUrlSyntax(raw);
  url.hash = '';
  const hostSpecific = HOST_TRACKING_PARAMETERS.find(([pattern]) => pattern.test(url.hostname))?.[1];
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMETERS.has(lower) || lower.startsWith('utm_') || hostSpecific?.has(lower)) url.searchParams.delete(key);
  }
  if (!url.searchParams.toString()) url.search = '';
  return url;
}

// ---------------------------------------------------------------------------
// Response decoding
// ---------------------------------------------------------------------------

function createDecoder(encoding, buffer) {
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip();
  if (encoding === 'br') return zlib.createBrotliDecompress();
  if (encoding === 'deflate') {
    const zlibHeader = buffer.length >= 2 && (buffer[0] & 0x0f) === 8 && ((buffer[0] << 8) | buffer[1]) % 31 === 0;
    return zlibHeader ? zlib.createInflate() : zlib.createInflateRaw();
  }
  throw new Error(`Server used an unsupported content encoding (${encoding}).`);
}

/** Inflates up to maxBytes and stops there; never rejects, so callers can keep a partial body. */
function inflateCapped(decoder, input, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let truncated = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      decoder.destroy();
      resolve({ body: Buffer.concat(chunks), truncated, error: error ?? null });
    };
    decoder.on('data', (chunk) => {
      if (truncated) return;
      const room = maxBytes - bytes;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        bytes = maxBytes;
        truncated = true;
        finish(null);
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    });
    decoder.on('error', (error) => finish(new Error(`Response could not be decompressed (${error.message}).`)));
    decoder.on('end', () => finish(null));
    decoder.end(input);
  });
}

/**
 * Decodes gzip/deflate/brotli bodies with a hard cap on decompressed bytes.
 * Returns whatever decoded, flagging `truncated` when the cap cut it short
 * (or the raw read already had) and `error` when the stream was unreadable.
 */
export async function decodeResponseBodyLenient(buffer, headers = {}, maxBytes = MAX_RESPONSE_BYTES, inputTruncated = false) {
  const encodings = String(headers['content-encoding'] ?? '')
    .toLowerCase()
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item !== 'identity');
  let body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  let truncated = false;
  let error = null;
  for (const encoding of encodings.reverse()) {
    const result = await inflateCapped(createDecoder(encoding, body), body, maxBytes);
    body = result.body;
    truncated ||= result.truncated;
    if (result.error) {
      // A stream cut at the byte cap ends mid-block; what decoded before that is still the page.
      if ((inputTruncated || truncated) && body.length) { truncated = true; break; }
      error = result.error;
      break;
    }
  }
  if (body.length > maxBytes) { body = body.subarray(0, maxBytes); truncated = true; }
  return { body, truncated: truncated || inputTruncated, error };
}

const CHARSET_LABELS = {
  'utf8': 'utf-8', 'utf-8': 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
  'iso-8859-1': 'windows-1252', 'iso8859-1': 'windows-1252', 'latin1': 'windows-1252', 'latin-1': 'windows-1252',
  'l1': 'windows-1252', 'windows-1252': 'windows-1252', 'cp1252': 'windows-1252', 'ascii': 'windows-1252', 'us-ascii': 'windows-1252',
  'iso-8859-15': 'iso-8859-15', 'latin9': 'iso-8859-15',
};

function sniffCharset(buffer, contentType) {
  const fromHeader = String(contentType ?? '').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader;
  const head = buffer.subarray(0, 4_096).toString('latin1');
  return head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?([\w-]+)/i)?.[1]
    ?? head.match(/<meta\b[^>]*content\s*=\s*["'][^"']*charset=([\w-]+)/i)?.[1]
    ?? head.match(/<\?xml\b[^>]*encoding\s*=\s*["']([\w-]+)/i)?.[1]
    ?? null;
}

/** Decodes a body to text using the declared charset (utf-8 by default). */
export function decodeBodyText(buffer, contentType = '') {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  const declared = (sniffCharset(body, contentType) ?? 'utf-8').toLowerCase();
  const label = CHARSET_LABELS[declared] ?? declared;
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// ---------------------------------------------------------------------------
// HTTP transport and fetch policy
// ---------------------------------------------------------------------------

/**
 * One HTTPS GET to a pre-resolved address. Reads at most maxBytes: a larger
 * body is cut there and returned with truncated: true rather than rejected,
 * so the parsers still see the part of the page that holds the recipe.
 */
function httpsTransport(url, { headers, timeoutMs, address, family, maxBytes }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
    const request = https.request(url, {
      method: 'GET',
      headers,
      family,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      signal: controller.signal,
    }, (incoming) => {
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      const complete = () => finish(null, { status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks), truncated });
      incoming.on('data', (chunk) => {
        if (truncated) return;
        const room = maxBytes - bytes;
        if (chunk.length > room || bytes >= maxBytes) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          bytes = maxBytes;
          truncated = true;
          complete();
          incoming.destroy();
          return;
        }
        bytes += chunk.length;
        chunks.push(chunk);
      });
      incoming.on('error', (error) => finish(error));
      incoming.on('end', complete);
    });
    request.on('error', (error) => finish(error.name === 'AbortError' ? new Error('Request timed out.') : error));
    request.end();
  });
}

function isReaderUrl(url) {
  return url.hostname.toLowerCase() === 'r.jina.ai';
}

function requestHeaders(profile, url) {
  const reader = isReaderUrl(url);
  const headers = { ...REQUEST_PROFILES[reader ? 'reader' : profile] };
  if (reader && process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  return headers;
}

export const INSECURE_PAGE_MESSAGE = 'This site only serves an insecure (http) page.';

export function looksLikeBotChallenge(status, body) {
  if (RETRYABLE_STATUSES.has(status)) return true;
  const text = String(body ?? '');
  if (text.length > CHALLENGE_BODY_LIMIT) return false;
  const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '';
  return CHALLENGE_TITLE_MARKERS.some((marker) => marker.test(title))
    || CHALLENGE_MARKERS.some((marker) => marker.test(text))
    || CHALLENGE_CONTAINER.test(text);
}

async function requestWithRedirects(startUrl, profile, options, budget) {
  let current = startUrl;
  const visited = new Set();
  let insecureRetried = false;
  for (let redirect = 0; redirect <= options.maxRedirects; redirect += 1) {
    if (visited.has(current.href)) throw new Error('Redirect loop detected.');
    visited.add(current.href);
    budget.take();
    // Every hop, DNS included, runs inside min(request timeout, time left before the absolute deadline).
    const hopTimeout = Math.min(options.timeoutMs, options.deadline - Date.now());
    if (hopTimeout < 250) throw new Error('Request timed out.');
    const hopDeadline = Date.now() + hopTimeout;
    const addresses = await resolvePublicAddress(current, options.resolver, Math.min(hopTimeout, 5_000));
    const selected = addresses.find((answer) => answer.family === 4) ?? addresses[0];
    const remaining = hopDeadline - Date.now();
    if (remaining < 250) throw new Error('Request timed out.');
    const response = await options.transport(current, {
      headers: requestHeaders(profile, current),
      timeoutMs: remaining,
      address: selected.address,
      family: selected.family,
      maxBytes: options.maxBytes,
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.headers?.location) throw new Error(`Redirect response ${response.status} did not include a destination.`);
      if (redirect >= options.maxRedirects) throw new Error('Too many redirects.');
      const target = new URL(response.headers.location, current);
      if (target.protocol === 'http:') {
        // Retry the same path over https once; a site that insists on http is not fetched.
        target.protocol = 'https:';
        target.port = '';
        if (insecureRetried || visited.has(target.href)) throw new Error(INSECURE_PAGE_MESSAGE);
        insecureRetried = true;
      }
      current = validateUrlSyntax(target.href);
      continue;
    }
    const decoded = await decodeResponseBodyLenient(response.body, response.headers ?? {}, options.maxBytes, Boolean(response.truncated));
    if (decoded.error && !decoded.body.length) throw decoded.error;
    const result = {
      status: response.status,
      headers: response.headers ?? {},
      url: current,
      truncated: decoded.truncated || Boolean(decoded.error),
      bytes: decoded.body,
    };
    if (!options.binary) result.body = decodeBodyText(decoded.body, response.headers?.['content-type']);
    return result;
  }
  throw new Error('Too many redirects.');
}

/**
 * Fetch policy: an honest user agent first; on a 403/406/429/503 or a
 * bot-challenge page, one retry with browser-like headers. A 2xx that merely
 * looked like a challenge is kept and returned if the retry does no better.
 * The public reader always gets its own fixed headers, so it is requested once.
 * Redirects stay on https (one http target is retried as https; a second
 * fails), every request is counted against the job budget through
 * options.onAdditionalRequest, the whole call ends at options.deadline, and
 * bodies are read, decompressed and charset-decoded up to a hard size cap
 * (anything past it is dropped and the result is flagged `truncated`).
 * With options.binary the raw bytes are returned instead of text.
 */
export async function fetchWithFallbacks(rawUrl, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? REQUEST_TIMEOUT_MS), 1_000), REQUEST_TIMEOUT_MS);
  const settings = {
    transport: options.transport ?? httpsTransport,
    resolver: options.resolver ?? dnsLookup,
    maxBytes: Math.min(Math.max(Number(options.maxBytes ?? MAX_RESPONSE_BYTES), 1), MAX_RESPONSE_BYTES),
    maxRedirects: Math.min(Math.max(Number(options.maxRedirects ?? MAX_REDIRECTS), 0), MAX_REDIRECTS),
    timeoutMs,
    deadline: Number.isFinite(options.deadline) ? Number(options.deadline) : Date.now() + timeoutMs * 2,
    binary: Boolean(options.binary),
  };
  const startUrl = validateUrlSyntax(rawUrl);
  const profiles = options.profile ? [options.profile] : isReaderUrl(startUrl) ? ['reader'] : ['honest', 'browser'];
  let requests = 0;
  const budget = { take() { requests += 1; if (requests > 1) options.onAdditionalRequest?.(); } };

  let last = null;
  let held = null;
  for (const profile of profiles) {
    last = await requestWithRedirects(startUrl, profile, settings, budget);
    const ok = last.status >= 200 && last.status < 300;
    const challenged = looksLikeBotChallenge(last.status, last.body ?? '');
    if (ok && !challenged) return last;
    if (ok) held ??= last;
    else if (!challenged) break; // A 404 or other definitive answer: do not retry.
  }
  if (held) return held;
  throw new Error(`Remote server returned HTTP ${last.status}.`);
}

export async function safeFetchText(rawUrl, options = {}) {
  return fetchWithFallbacks(rawUrl, options);
}

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

const PAYWALL_MESSAGE = 'This page keeps its recipe behind a sign-in. Open it in your browser, copy the recipe text, and paste it into Savor.';
const VIDEO_DISCLAIMER = 'Savor checked public caption and page text only; it did not transcribe or analyze the reel video or audio.';

function makeReaderUrl(target) {
  return new URL(`${READER_ORIGIN}${target.href}`);
}

function sourceRecord(kind, url, label) {
  return { kind, url: url.href, label: cleanText(label, 160) };
}

function hostLabel(url) {
  return url.hostname.replace(/^www\./, '');
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
  // requestedUrl is the link exactly as the app sent it; url is the canonical
  // form the importer works with (tracking parameters removed).
  return { jobId: jobId || fallbackJobId, requestedUrl: validateUrlSyntax(request.url), url: normalizeSourceUrl(request.url) };
}

function looksClientRendered(visibleText) {
  return visibleText.length < MIN_RENDERED_TEXT_CHARS
    || /\b(?:loading(?:…|\.{3})?|enable javascript|javascript is (?:required|disabled)|you need to enable javascript)\b/i.test(visibleText.slice(0, 2_000));
}

function pickCandidate(candidates) {
  const withEvidence = candidates.filter((candidate) => evidenceDraft(candidate.draft));
  return withEvidence.find((candidate) => completeDraft(candidate.draft))
    ?? [...withEvidence].sort((left, right) => recipeEvidenceScore(right.draft) - recipeEvidenceScore(left.draft))[0]
    ?? null;
}

/** Structured data from any source beats visible text; among equals, more evidence wins. */
function preferCandidate(candidate, best) {
  if (!candidate || !evidenceDraft(candidate.draft)) return false;
  if (!best) return true;
  if (candidate.structured && !best.structured) return completeDraft(candidate.draft) || !completeDraft(best.draft);
  if (!candidate.structured && best.structured) return false;
  return recipeEvidenceScore(candidate.draft) > recipeEvidenceScore(best.draft);
}

const PRINT_LINK = /wprm_print|\?print=|\/print\/?$/i;

function registrableDomain(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const depth = /\.(?:co|com|org|net|gov|edu|ac|ne|or)\.[a-z]{2}$/.test(host) ? 3 : 2;
  return labels.slice(-depth).join('.');
}

function wprmPrintUrl(url) {
  const slug = url.pathname.split('/').filter(Boolean).pop();
  return slug && !/^wprm_print$/i.test(slug) && !url.pathname.includes('/wprm_print/') ? new URL(`/wprm_print/${slug}`, url.origin) : null;
}

/**
 * Other views of the same page worth a request when the page itself gave only
 * text (or nothing), in the order they are tried: the canonical page when it
 * differs, a print view, the AMP page. All must sit on the same site.
 */
function alternatePageUrls(elements, pageUrl, wprm) {
  const candidates = [];
  const site = registrableDomain(pageUrl.hostname);
  const push = (kind, label, href) => {
    try {
      const target = new URL(href, pageUrl);
      if (target.protocol === 'http:') { target.protocol = 'https:'; target.port = ''; }
      const url = normalizeSourceUrl(target.href);
      if (url.href === pageUrl.href || registrableDomain(url.hostname) !== site || candidates.some((entry) => entry.url.href === url.href)) return;
      candidates.push({ kind, label, url });
    } catch { /* Not a usable https link. */ }
  };
  const rel = (element, name) => new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'i').test(String(element.attrs.rel ?? ''));
  const canonical = elements.find((element) => element.name === 'link' && element.attrs.href && rel(element, 'canonical'));
  if (canonical) push('canonical', 'Canonical page', canonical.attrs.href);
  const print = elements.find((element) => element.name === 'a' && element.attrs.href && (PRINT_LINK.test(element.attrs.href) || PRINT_LINK.test(element.attrs.href.split(/[?#]/)[0])));
  if (print) push('print', 'Print view', print.attrs.href);
  else if (wprm) {
    const guess = wprmPrintUrl(pageUrl);
    if (guess) push('print', 'Print view', guess.href);
  }
  const amp = elements.find((element) => element.name === 'link' && element.attrs.href && rel(element, 'amphtml'));
  if (amp) push('amp', 'AMP page', amp.attrs.href);
  return candidates;
}

/** Runs every HTML extractor in order (JSON-LD, microdata, plugins, visible text) and keeps the best evidence. */
export function extractRecipeFromHtml(html, sourceUrl) {
  const elements = scanElements(html);
  const { meta, h1, title, siteName } = pageMetadata(html, elements);
  const pageTitle = (fallback = '') => pickRecipeTitle({ h1, ogTitle: meta['og:title'], pageTitle: title, fallback, siteName, hostname: sourceUrl.hostname });
  const schema = bestSchemaDraft(html, sourceUrl);
  const candidates = [];
  if (schema.draft) candidates.push({ draft: schema.draft, provider: 'schema-org', structured: true });
  const microdata = extractMicrodataRecipe(html, sourceUrl, elements);
  if (microdata) candidates.push({ draft: microdata, provider: 'microdata', structured: true });
  const plugin = extractPluginRecipe(html, sourceUrl, elements);
  if (plugin) candidates.push({ draft: plugin.draft, provider: 'text-parser', structured: true });
  const visibleText = htmlToText(html);
  // For an ordinary web page the page's own title (h1, og:title, <title>) is authoritative.
  const authoritativeTitle = isInstagramHost(sourceUrl.hostname) ? '' : pageTitle();
  const textDraft = parseRecipeCaption(visibleText, { title, sourceURL: sourceUrl.href, sourceName: hostLabel(sourceUrl) });
  textDraft.title = authoritativeTitle || pageTitle(textDraft.title) || textDraft.title;
  candidates.push({ draft: textDraft, provider: 'text-parser', structured: false });

  for (const candidate of candidates) {
    candidate.draft.title ||= pageTitle();
    candidate.draft.heroImage ??= safeDisplayImage(meta['og:image']);
  }
  const chosen = pickCandidate(candidates);
  const wprm = detectRecipePlugin(html) === 'wprm';
  return {
    chosen,
    paywalled: schema.paywalled && !chosen,
    clientRendered: !chosen && looksClientRendered(visibleText),
    wprm,
    alternates: alternatePageUrls(elements, sourceUrl, wprm && !chosen?.draft.ingredients.length),
    links: extractPageLinks(html, sourceUrl, elements),
  };
}

function fetchOptions(context, url, extra = {}) {
  return {
    timeoutMs: context.remainingTime(),
    deadline: Math.min(Date.now() + REQUEST_TIMEOUT_MS * 2, context.deadline),
    maxBytes: isReaderUrl(url) ? READER_MAX_RESPONSE_BYTES : MAX_RESPONSE_BYTES,
    onAdditionalRequest: () => context.takeRequest(),
    ...extra,
  };
}

/**
 * Fetches one page against the job budget. The request is taken from the
 * budget before its sourcesChecked record is written, so a page the budget
 * never allowed is not listed as checked.
 */
async function fetchPage(url, context, { record = null, ...extra } = {}) {
  context.takeRequest();
  if (record) context.sourcesChecked.push(record);
  const requestOptions = fetchOptions(context, url, extra);
  const response = await context.fetchText(url, requestOptions);
  if (response.truncated) {
    context.truncated = true;
    // Remember the largest cap that cut a body, so the warning names the right one.
    context.truncatedCap = Math.max(context.truncatedCap ?? 0, requestOptions.maxBytes ?? MAX_RESPONSE_BYTES);
  }
  return { ...response, url: normalizeSourceUrl(response.url ?? url) };
}

async function readerDraft(url, context) {
  const response = await fetchPage(makeReaderUrl(url), context);
  const { content, title, ogTitle } = readerPageText(response.body);
  const draft = parseRecipeCaption(content, { title, sourceURL: url.href, sourceName: hostLabel(url) });
  draft.title = pickRecipeTitle({ ogTitle, pageTitle: title, hostname: url.hostname }) || draft.title;
  return evidenceDraft(draft) ? { draft, provider: 'public-reader', structured: false } : null;
}

async function inspectRecipePage(url, context, { allowReader = false } = {}) {
  const host = hostLabel(url);
  const response = await fetchPage(url, context, {
    record: sourceRecord('recipe-page', url, isLinkHubUrl(url) ? `Creator links on ${host}` : `Recipe page on ${host}`),
  });
  // A redirect (trailing slash, moved page) is recorded as a source checked and
  // on the draft's links; the draft itself keeps reporting the requested URL.
  const finalUrl = response.url;
  const redirected = finalUrl.href !== url.href;
  const finalRecord = sourceRecord('recipe-page', finalUrl, `Recipe page on ${hostLabel(finalUrl)}`);
  if (redirected) context.sourcesChecked.push(finalRecord);
  const page = extractRecipeFromHtml(response.body, finalUrl);
  let best = page.chosen;
  if (!best && page.paywalled) throw new Error(PAYWALL_MESSAGE);

  // A text-mode or empty result gets a second chance from the page's own
  // alternate views (canonical, print, AMP), then from the public reader. A
  // page reached from a crawl spends budget on that only when it showed some evidence.
  const settled = () => Boolean(best?.structured) && completeDraft(best.draft);
  if (!settled() && (allowReader || (best && !completeDraft(best.draft)))) {
    for (const alternate of page.alternates) {
      if (settled()) break;
      try {
        const view = await fetchPage(alternate.url, context, { record: sourceRecord('recipe-page', alternate.url, `${alternate.label} on ${hostLabel(alternate.url)}`) });
        const candidate = extractRecipeFromHtml(view.body, view.url).chosen;
        if (preferCandidate(candidate, best)) best = candidate;
      } catch { /* Alternate views are a bonus; the page result stands. */ }
    }
  }
  if (!completeDraft(best?.draft) && allowReader && !isReaderExcluded(finalUrl)) {
    try {
      const candidate = await readerDraft(finalUrl, context);
      if (preferCandidate(candidate, best)) best = candidate;
    } catch (error) { context.warnings.push(userFacingFetchWarning('recipe-page', error)); }
  }
  if (best?.draft) {
    best.draft.sourceURL = url.href;
    if (redirected) best.draft.sourceLinks = [finalRecord];
  }
  return { draft: best?.draft ?? null, provider: best?.provider ?? null, links: page.links };
}

async function readInstagramPost(sourceUrl, context, record) {
  const shortcode = instagramShortcode(sourceUrl);
  let pendingRecord = record;
  const takeRecord = () => { const current = pendingRecord; pendingRecord = null; return current; };
  if (shortcode) {
    try {
      const response = await fetchPage(instagramEmbedUrl(shortcode), context, { profile: 'browser', record: takeRecord() });
      const post = parseInstagramEmbed(response.body, sourceUrl);
      if (post) return post;
    } catch { /* The reader below is the fallback for embed misses. */ }
  }
  const response = await fetchPage(makeReaderUrl(sourceUrl), context, { record: takeRecord() });
  return parseInstagramReaderPayload(response.body, sourceUrl);
}

async function creatorRelatedUrls(profileUrl, creator, context) {
  try {
    const record = sourceRecord('creator-profile', profileUrl, `Instagram creator @${creator}`);
    const response = await fetchPage(makeReaderUrl(profileUrl), context, { record });
    return parseInstagramReaderPayload(response.body, profileUrl).relatedUrls;
  } catch (error) {
    context.warnings.push(userFacingFetchWarning('creator-profile', error));
    return [];
  }
}

async function crawlRelatedPages(initialUrls, titleTokens, sourceUrl, context, onPage) {
  let queue = rankRelatedUrls(unique(initialUrls.filter((url) => isLikelyRelatedUrl(url, sourceUrl)).map((url) => url.href)).map((url) => new URL(url)), titleTokens);
  const seen = new Set();
  let pagesChecked = 0;
  while (queue.length && pagesChecked < MAX_RELATED_PAGES) {
    const candidate = queue.shift();
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    pagesChecked += 1;
    try {
      const page = await inspectRecipePage(candidate, context);
      if (onPage(page, candidate) === 'done') return;
      const discovered = page.links.filter((link) => !seen.has(link.href) && isLikelyRelatedUrl(link, candidate));
      if (discovered.length) queue = rankRelatedUrls(unique([...queue, ...discovered].map((url) => url.href)).map((url) => new URL(url)), titleTokens);
    } catch (error) {
      context.warnings.push(userFacingFetchWarning('recipe-page', error));
    }
  }
}

async function processInstagram(sourceUrl, context) {
  const { warnings } = context;
  warnings.push(VIDEO_DISCLAIMER);
  let post;
  try {
    post = await readInstagramPost(sourceUrl, context, sourceRecord('instagram-post', sourceUrl, 'Public Instagram post'));
  } catch (error) {
    warnings.push(userFacingFetchWarning('instagram-post', error));
    return { draft: null, provider: 'public-reader' };
  }

  const author = post.creator ? `@${post.creator}` : null;
  const profileUrl = post.creator ? normalizeSourceUrl(`https://www.instagram.com/${post.creator}/`) : null;
  const sourceLinks = [sourceRecord('instagram-post', sourceUrl, 'Original Instagram post')];
  if (profileUrl) sourceLinks.push(sourceRecord('creator-profile', profileUrl, `Instagram creator @${post.creator}`));
  const captionDraft = parseRecipeCaption(post.caption, {
    title: post.title,
    sourceURL: sourceUrl.href,
    sourceName: 'Instagram',
    author,
    // Instagram CDN images are short-lived hotlinks and would make a saved
    // recipe contact Meta directly. Linked recipe pages may provide a stable image.
    heroImage: null,
  });
  captionDraft.sourceLinks = sourceLinks;
  let best = evidenceDraft(captionDraft) ? captionDraft : null;
  let provider = best ? 'instagram-caption' : 'public-reader';
  if (completeDraft(best)) return { draft: best, provider };

  const candidateUrls = [...post.relatedUrls];
  if (profileUrl) candidateUrls.push(...await creatorRelatedUrls(profileUrl, post.creator, context));
  const titleTokens = recipeTitleTokens(captionDraft.title || post.title || '');
  await crawlRelatedPages(candidateUrls, titleTokens, sourceUrl, context, (page, candidate) => {
    if (page.draft && recipeEvidenceScore(page.draft) > recipeEvidenceScore(best)) {
      best = page.draft;
      provider = 'linked-recipe';
      best.sourceURL = sourceUrl.href;
      best.sourceName = 'Instagram';
      best.author ||= author;
      best.sourceLinks = [...sourceLinks, sourceRecord('recipe-page', candidate, `Full recipe on ${hostLabel(candidate)}`)];
    }
    return completeDraft(best) ? 'done' : 'continue';
  });

  if (!best && post.caption) warnings.push('Public post text was found, but it did not contain identifiable ingredients or instructions.');
  else if (best && !best.ingredients.length) warnings.push('No ingredient list was found in the public sources checked.');
  else if (best && !best.instructions.length) warnings.push('No preparation steps were found in the public sources checked.');
  return { draft: best, provider };
}

function makeContext(options) {
  const warnings = [];
  const sourcesChecked = [];
  const startedAt = Date.now();
  let requestCount = 0;
  return {
    warnings,
    sourcesChecked,
    fetchText: options.fetchText ?? safeFetchText,
    // Image bytes travel through the same guarded fetch. A caller that mocks
    // fetchText without fetchBinary gets no image requests at all.
    fetchBinary: options.fetchBinary ?? (options.fetchText ? null : (url, fetchOpts) => safeFetchText(url, { ...fetchOpts, binary: true })),
    deadline: startedAt + JOB_TIMEOUT_MS,
    truncated: false,
    truncatedCap: 0,
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
}

// ---------------------------------------------------------------------------
// Hero image embedding and client-contract clamping
// ---------------------------------------------------------------------------

// Images on these hosts are short-lived or login-gated hotlinks; they are never fetched.
const IMAGE_HOTLINK_ONLY_DOMAINS = ['instagram.com', 'cdninstagram.com', 'fbcdn.net', 'facebook.com', 'fbsbx.com'];
const IMAGE_TYPES = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/pjpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

export function sniffImageType(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/**
 * An https image is only a hotlink: offline it disappears and some CDNs expire
 * it. A JPEG/PNG/WebP of at most MAX_HERO_IMAGE_BYTES from an ordinary host is
 * fetched (one request from the budget) and embedded as a data URL, which the
 * app's sync already uploads to a media file. Anything else keeps the URL, and
 * no image problem ever fails the import.
 */
async function embedHeroImage(draft, context) {
  const source = draft?.heroImage;
  if (typeof source !== 'string' || !/^https:/i.test(source) || !context.fetchBinary) return;
  let url;
  try { url = validateUrlSyntax(source); } catch { return; }
  if (hostInDomainList(url.hostname, IMAGE_HOTLINK_ONLY_DOMAINS)) return;
  try {
    context.takeRequest();
    const response = await context.fetchBinary(url, fetchOptions(context, url, { maxBytes: MAX_HERO_IMAGE_BYTES + 1, profile: 'image' }));
    const bytes = response?.bytes;
    if (response?.truncated || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_HERO_IMAGE_BYTES) return;
    if (response.status && (response.status < 200 || response.status >= 300)) return;
    const declared = IMAGE_TYPES[String(response.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()] ?? null;
    const sniffed = sniffImageType(bytes);
    const type = sniffed ?? declared;
    if (!type || (declared && sniffed && declared !== sniffed)) return;
    draft.heroImage = `data:image/${type};base64,${bytes.toString('base64')}`;
  } catch { /* The https URL stays; an image is never worth failing an import over. */ }
}

function clampString(value, max) {
  return typeof value === 'string' && value.length > max ? value.slice(0, max) : value;
}

/** Trims every field to the limits the app's result validator enforces. */
export function clampDraftToClientLimits(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  const { shortText, unit } = CLIENT_LIMITS;
  draft.title = clampString(draft.title, CLIENT_LIMITS.title);
  draft.description = clampString(draft.description, CLIENT_LIMITS.description);
  draft.notes = clampString(draft.notes, CLIENT_LIMITS.notes);
  for (const key of ['author', 'cuisine', 'sourceName']) draft[key] = clampString(draft[key], shortText);
  for (const key of ['categories', 'tags']) {
    draft[key] = (Array.isArray(draft[key]) ? draft[key] : []).slice(0, CLIENT_LIMITS.listItems).map((item) => clampString(item, shortText));
  }
  draft.ingredients = (Array.isArray(draft.ingredients) ? draft.ingredients : []).slice(0, CLIENT_LIMITS.ingredients).map((ingredient) => ({
    ...ingredient,
    rawText: clampString(ingredient.rawText, CLIENT_LIMITS.rawText),
    ingredientName: clampString(ingredient.ingredientName, shortText),
    normalizedIngredient: clampString(ingredient.normalizedIngredient, shortText),
    descriptor: clampString(ingredient.descriptor, shortText),
    preparation: clampString(ingredient.preparation, shortText),
    section: clampString(ingredient.section, shortText),
    note: clampString(ingredient.note, shortText),
    unit: clampString(ingredient.unit, unit),
    normalizedUnit: clampString(ingredient.normalizedUnit, unit),
  }));
  draft.instructions = (Array.isArray(draft.instructions) ? draft.instructions : []).slice(0, CLIENT_LIMITS.instructions).map((step, index) => ({
    ...step,
    stepNumber: index + 1,
    text: clampString(step.text, CLIENT_LIMITS.instruction),
    section: clampString(step.section, shortText),
  }));
  if (Array.isArray(draft.sourceLinks)) {
    draft.sourceLinks = draft.sourceLinks.slice(0, CLIENT_LIMITS.links).map((link) => ({ ...link, label: clampString(link.label, shortText) }));
  }
  return draft;
}

function clampSources(sources) {
  return sources.slice(0, CLIENT_LIMITS.links).map((source) => ({ ...source, label: clampString(source.label, CLIENT_LIMITS.shortText) }));
}

function errorResult(jobId, message, context, completedAt) {
  return {
    version: 1, importerVersion: IMPORTER_VERSION, jobId, status: 'error',
    warnings: sanitizeWarnings(context.warnings), provider: 'public-reader',
    sourcesChecked: clampSources(context.sourcesChecked), error: cleanText(message, 500), completedAt,
  };
}

export async function processImportRequest(request, options = {}) {
  const completedAt = options.now?.() ?? new Date().toISOString();
  const fallbackJobId = options.fallbackJobId ?? 'unknown';
  let jobId = typeof request?.jobId === 'string' && request.jobId.trim() ? request.jobId.trim().slice(0, 128) : fallbackJobId;
  const context = makeContext(options);
  try {
    const validated = assertRequest(request, fallbackJobId);
    jobId = validated.jobId;
    const instagram = isInstagramHost(validated.url.hostname);
    // The app accepts a result only when the link it sent appears among the
    // sources checked, so record it verbatim whenever canonicalisation changed it.
    if (validated.requestedUrl.href !== validated.url.href) {
      context.sourcesChecked.push(sourceRecord(instagram ? 'instagram-post' : 'recipe-page', validated.requestedUrl, 'Link as shared'));
    }
    let imported;
    if (instagram) {
      imported = await processInstagram(validated.url, context);
    } else {
      const page = await inspectRecipePage(validated.url, context, { allowReader: true });
      imported = { draft: page.draft, provider: page.provider ?? 'public-reader' };
      if (!page.draft) context.warnings.push('No Schema.org Recipe data or identifiable ingredient/instruction sections were found.');
      else if (!completeDraft(page.draft)) context.warnings.push('Only part of the recipe could be identified; review the imported fields before saving.');
    }
    if (context.truncated && !completeDraft(imported.draft)) {
      const cap = context.truncatedCap || MAX_RESPONSE_BYTES;
      const subject = cap < MAX_RESPONSE_BYTES ? 'The readable copy of the page' : 'The page';
      context.warnings.push(`${subject} was larger than the importer reads (${Math.round(cap / (1024 * 1024))} MB); only its first part was parsed.`);
    }
    const status = resultStatus(imported.draft);
    if (status === 'error') {
      return { ...errorResult(jobId, 'No usable recipe details were found in the public sources checked.', context, completedAt), provider: imported.provider };
    }
    await embedHeroImage(imported.draft, context);
    return {
      version: 1, importerVersion: IMPORTER_VERSION, jobId, status, draft: clampDraftToClientLimits(imported.draft),
      warnings: sanitizeWarnings(context.warnings), provider: imported.provider,
      sourcesChecked: clampSources(context.sourcesChecked), completedAt,
    };
  } catch (error) {
    return errorResult(jobId, error instanceof Error ? error.message : 'Unknown importer error.', context, completedAt);
  }
}

// ---------------------------------------------------------------------------
// Queue files and CLI
// ---------------------------------------------------------------------------

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

/**
 * Processes pending request files oldest-first. options.maxRunMs (default 15
 * minutes) is a wall-clock budget for the whole run: once it is spent no
 * further request is dequeued, and the summary reports them as `deferred` so
 * the next run picks them up.
 */
export async function processPendingRequests(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const requestDirectory = path.join(root, REQUEST_DIRECTORY);
  const resultDirectory = path.join(root, RESULT_DIRECTORY);
  const maxJobs = Math.min(Math.max(Number(options.maxJobs ?? MAX_JOBS_DEFAULT), 1), 100);
  const requestedRunMs = Number(options.maxRunMs ?? DEFAULT_MAX_RUN_MS);
  const maxRunMs = Number.isFinite(requestedRunMs) && requestedRunMs >= 0 ? requestedRunMs : DEFAULT_MAX_RUN_MS;
  const startedAt = Date.now();
  const summary = { processed: 0, success: 0, partial: 0, failed: 0, deferred: 0, results: [] };
  let entries;
  try { entries = await fs.readdir(requestDirectory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return summary;
    throw error;
  }

  const pending = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const resultPath = path.join(resultDirectory, entry.name);
    if (!(await pathExists(resultPath))) pending.push({ name: entry.name, resultPath });
    if (pending.length >= maxJobs) break;
  }

  for (const item of pending) {
    if (Date.now() - startedAt >= maxRunMs) { summary.deferred += 1; continue; }
    const requestPath = path.join(requestDirectory, item.name);
    const fallbackJobId = safeFallbackJobId(item.name);
    let request;
    let result;
    try {
      const stat = await fs.stat(requestPath);
      if (stat.size > MAX_REQUEST_FILE_BYTES) throw new Error('Import request file exceeds the size limit.');
      request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
      result = await processImportRequest(request, { fallbackJobId, fetchText: options.fetchText, fetchBinary: options.fetchBinary, now: options.now });
    } catch (error) {
      result = errorResult(
        typeof request?.jobId === 'string' ? request.jobId.slice(0, 128) : fallbackJobId,
        error instanceof Error ? error.message : 'Invalid import request.',
        { warnings: [], sourcesChecked: [] },
        options.now?.() ?? new Date().toISOString(),
      );
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

export function parseArguments(argv) {
  const options = { root: process.cwd(), maxJobs: MAX_JOBS_DEFAULT, maxRunMs: DEFAULT_MAX_RUN_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--max-jobs') options.maxJobs = Number(argv[++index]);
    else if (argument === '--max-run-minutes') options.maxRunMs = Number(argv[++index]) * 60_000;
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.root) throw new Error('--root requires a directory.');
  if (!Number.isInteger(options.maxJobs) || options.maxJobs < 1 || options.maxJobs > 100) throw new Error('--max-jobs must be an integer from 1 to 100.');
  if (!Number.isFinite(options.maxRunMs) || options.maxRunMs < 60_000 || options.maxRunMs > 6 * 60 * 60_000) throw new Error('--max-run-minutes must be a number from 1 to 360.');
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
    `deferred=${summary.deferred}`,
    `results=${JSON.stringify(summary.results)}`,
  ];
  return fs.appendFile(outputFile, `${lines.join('\n')}\n`, 'utf8');
}

const MINIMUM_NODE_MAJOR = 20;

async function main() {
  const nodeMajor = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    console.error(`The Savor recipe importer needs Node.js ${MINIMUM_NODE_MAJOR} or newer (found ${process.versions.node}). ubuntu-latest runners ship Node 20+; add actions/setup-node if yours does not.`);
    process.exitCode = 1;
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/process-recipe-imports.mjs [--root PATH] [--max-jobs COUNT] [--max-run-minutes MINUTES]');
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

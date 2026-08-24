import type { StoredGitHubConnection } from './client-cache';
import type {
  Attachment,
  GroceryCategory,
  ImportResult,
  Ingredient,
  Instruction,
  RecipeDraft,
  RecipeSourceLink,
  SourceType,
} from './types';

const API_ROOT = 'https://api.github.com';
const REQUEST_ROOT = 'savor/v1/imports/requests';
const RESULT_ROOT = 'savor/v1/imports/results';
const WORKFLOW_PATH = '.github/workflows/savor-recipe-import.yml';
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 20_000;

const SOURCE_TYPES = new Set<SourceType>(['url', 'photo', 'screenshot', 'pasted-text', 'manual']);
const GROCERY_CATEGORIES = new Set<GroceryCategory>([
  'Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry', 'Canned & Jarred',
  'Pasta, Rice & Grains', 'Spices & Seasonings', 'Sauces & Condiments', 'Other',
]);
const RESULT_PROVIDERS = new Set(['schema-org', 'instagram-caption', 'linked-recipe', 'public-reader']);
const SOURCE_KINDS = new Set(['instagram-post', 'creator-profile', 'recipe-page']);
const TRACKING_PARAMETERS = new Set(['igsh', 'igshid', 'fbclid', 'gclid', 'mc_cid', 'mc_eid']);

export interface GitHubImportOptions {
  onProgress?: (stage: 'queued' | 'reading' | 'structuring') => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ImportRecipeUrl = (url: string, options?: GitHubImportOptions) => Promise<ImportResult>;

interface GitHubContents {
  type: 'file';
  sha: string;
  content?: string;
  encoding?: string;
}

type CheckedSource = RecipeSourceLink;

interface SuccessfulQueueResult {
  version: 1;
  jobId: string;
  status: 'success' | 'partial';
  draft: RecipeDraft;
  warnings: string[];
  provider: 'schema-org' | 'instagram-caption' | 'linked-recipe' | 'public-reader';
  sourcesChecked: CheckedSource[];
  completedAt: string;
}

export class GitHubImportError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = 'GitHubImportError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function encodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

function decodeText(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function isSafeHttpUrl(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true;
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443');
  } catch {
    return false;
  }
}

function isSafeImage(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 1_300_000) return false;
  if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return true;
  return isSafeHttpUrl(value);
}

function isString(value: unknown, max = 20_000): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isNullableString(value: unknown, max = 2_048): value is string | null {
  return value === null || isString(value, max);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isStringArray(value: unknown, maxItems = 100): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isString(item, 500));
}

function isRational(value: unknown): boolean {
  return value === null || (isObject(value)
    && typeof value.numerator === 'number' && Number.isFinite(value.numerator)
    && typeof value.denominator === 'number' && Number.isFinite(value.denominator)
    && value.denominator !== 0);
}

function isIngredient(value: unknown): value is Ingredient {
  return isObject(value)
    && isString(value.id, 200)
    && isString(value.rawText, 2_000)
    && isRational(value.quantity)
    && isNullableString(value.unit, 100)
    && isNullableString(value.normalizedUnit, 100)
    && isString(value.ingredientName, 500)
    && isString(value.normalizedIngredient, 500)
    && isNullableString(value.descriptor, 500)
    && isNullableString(value.preparation, 500)
    && typeof value.groceryCategory === 'string'
    && GROCERY_CATEGORIES.has(value.groceryCategory as GroceryCategory)
    && typeof value.optional === 'boolean'
    && isNullableString(value.section, 500)
    && typeof value.confidence === 'number'
    && Number.isFinite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
    && typeof value.needsReview === 'boolean';
}

function isInstruction(value: unknown): value is Instruction {
  return isObject(value)
    && isString(value.id, 200)
    && typeof value.stepNumber === 'number'
    && Number.isInteger(value.stepNumber)
    && value.stepNumber >= 1
    && isNullableString(value.section, 500)
    && isString(value.text, 10_000)
    && isNullableNumber(value.timerMinutes);
}

function isAttachment(value: unknown): value is Attachment {
  return isObject(value)
    && isString(value.id, 200)
    && ['original-photo', 'screenshot', 'other'].includes(String(value.type))
    && isSafeImage(value.url)
    && typeof value.url === 'string'
    && isString(value.mimeType, 200)
    && isString(value.originalFilename, 500)
    && isString(value.captureDate, 100);
}

function isCheckedSource(value: unknown): value is CheckedSource {
  return isObject(value)
    && typeof value.kind === 'string'
    && SOURCE_KINDS.has(value.kind)
    && isSafeHttpUrl(value.url)
    && isString(value.label, 500);
}

function parseDraft(value: unknown): RecipeDraft {
  if (!isObject(value)
    || !isString(value.id, 200)
    || !isString(value.title, 1_000)
    || !isString(value.description, 20_000)
    || !isSafeImage(value.heroImage)
    || typeof value.sourceType !== 'string'
    || !SOURCE_TYPES.has(value.sourceType as SourceType)
    || !isSafeHttpUrl(value.sourceURL, true)
    || !isNullableString(value.sourceName, 500)
    || (value.sourceLinks !== undefined
      && (!Array.isArray(value.sourceLinks) || value.sourceLinks.length > 20 || !value.sourceLinks.every(isCheckedSource)))
    || !isNullableString(value.author, 500)
    || !isNullableNumber(value.servings)
    || !isNullableNumber(value.prepTime)
    || !isNullableNumber(value.cookTime)
    || !isNullableNumber(value.totalTime)
    || !isNullableString(value.cuisine, 500)
    || !isStringArray(value.categories)
    || !isStringArray(value.tags)
    || !Array.isArray(value.ingredients)
    || value.ingredients.length > 500
    || !value.ingredients.every(isIngredient)
    || !Array.isArray(value.instructions)
    || value.instructions.length > 500
    || !value.instructions.every(isInstruction)
    || !isNullableNumber(value.rating)
    || typeof value.favorite !== 'boolean'
    || !isString(value.notes, 50_000)
    || !Array.isArray(value.attachments)
    || value.attachments.length > 50
    || !value.attachments.every(isAttachment)) {
    throw new GitHubImportError('GitHub returned a recipe in an unsupported format. Update Savor and its recipe-import workflow, then try again.');
  }
  return structuredClone(value) as RecipeDraft;
}

function parseCheckedSources(value: unknown): CheckedSource[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new GitHubImportError('GitHub returned invalid recipe source details.');
  }
  return value.map((source) => {
    if (!isCheckedSource(source)) {
      throw new GitHubImportError('GitHub returned invalid recipe source details.');
    }
    return structuredClone(source);
  });
}

function parseQueueResult(value: unknown, jobId: string, sourceUrl: string): SuccessfulQueueResult {
  if (!isObject(value) || value.version !== 1 || value.jobId !== jobId || typeof value.status !== 'string') {
    throw new GitHubImportError('GitHub returned an invalid recipe-import result.');
  }
  if (value.status === 'error') {
    const message = isString(value.error, 2_000) && value.error.trim()
      ? value.error.trim()
      : 'The public post did not contain enough recipe information to import.';
    throw new GitHubImportError(message);
  }
  if (!['success', 'partial'].includes(value.status)
    || typeof value.provider !== 'string'
    || !RESULT_PROVIDERS.has(value.provider)
    || !isStringArray(value.warnings, 100)
    || !isString(value.completedAt, 100)) {
    throw new GitHubImportError('GitHub returned an invalid recipe-import result.');
  }
  const draft = parseDraft(value.draft);
  const sourcesChecked = parseCheckedSources(value.sourcesChecked);
  if (draft.sourceURL !== sourceUrl || !sourcesChecked.some((source) => source.url === sourceUrl)) {
    throw new GitHubImportError('GitHub returned recipe details for a different source link. Nothing was imported.');
  }
  return {
    version: 1,
    jobId,
    status: value.status as SuccessfulQueueResult['status'],
    draft,
    warnings: value.warnings,
    provider: value.provider as SuccessfulQueueResult['provider'],
    sourcesChecked,
    completedAt: value.completedAt,
  };
}

function abortError(): DOMException {
  return new DOMException('The recipe import was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function fetchWithTimeout(url: string, init: RequestInit, callerSignal?: AbortSignal): Promise<Response> {
  throwIfAborted(callerSignal);
  const controller = new AbortController();
  const handleAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', handleAbort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (callerSignal?.aborted) throw abortError();
    if (controller.signal.aborted) throw new GitHubImportError('GitHub did not respond while importing this recipe. Check your connection and try again.');
    throw new GitHubImportError(navigator.onLine
      ? 'Savor could not reach GitHub to import this recipe. Try again in a moment.'
      : 'You are offline. Reconnect to the internet before importing a recipe.');
  } finally {
    globalThis.clearTimeout(timer);
    callerSignal?.removeEventListener('abort', handleAbort);
  }
}

function friendlyGitHubError(response: Response, payload: { message?: string }): GitHubImportError {
  const rateLimited = response.status === 403
    && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0');
  const message = rateLimited
    ? 'GitHub’s API limit was reached. Wait a few minutes, then try importing the recipe again.'
    : response.status === 401
      ? 'The GitHub token saved on this device is invalid or expired. Replace it in Settings, then try again.'
      : response.status === 403
        ? 'GitHub denied the recipe import. Give this token Contents read/write access to the private data repository.'
        : response.status === 404
          ? 'GitHub could not find the private data repository with the saved token.'
          : response.status === 409
            ? 'GitHub changed while the recipe import was being queued. Try again.'
            : response.status === 422
              ? 'GitHub could not queue this recipe import. Check that the recipe-import workflow is installed and try again.'
              : payload.message || 'GitHub could not process the recipe import.';
  return new GitHubImportError(message, rateLimited ? 429 : response.status);
}

async function githubRequest(
  connection: StoredGitHubConnection,
  token: string,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  allowMissing = false,
): Promise<unknown | null> {
  const endpoint = `${API_ROOT}/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.repo)}`
    + `/contents/${encodedPath(path)}${init.method === 'GET' || !init.method ? `?ref=${encodeURIComponent(connection.branch)}` : ''}`;
  const response = await fetchWithTimeout(endpoint, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  }, signal);
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw friendlyGitHubError(response, payload);
  }
  if (response.status === 204) return null;
  return await response.json();
}

async function waitForPoll(delay: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delay);
    const handleAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function validateSourceUrl(value: string): string {
  const clean = value.trim();
  if (!isSafeHttpUrl(clean)) throw new GitHubImportError('Paste a complete public recipe or Instagram URL beginning with https://.');
  const url = new URL(clean);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  return url.href;
}

export async function queueGitHubRecipeImport(
  connection: StoredGitHubConnection | null,
  token: string,
  url: string,
  options: GitHubImportOptions = {},
): Promise<ImportResult> {
  if (!connection || !token.trim()) {
    throw new GitHubImportError('Connect your private GitHub data repository in Settings before importing a recipe from a link.');
  }
  if (!navigator.onLine) throw new GitHubImportError('You are offline. Reconnect to the internet before importing a recipe.');
  throwIfAborted(options.signal);

  const sourceUrl = validateSourceUrl(url);
  const jobId = crypto.randomUUID();
  const request = JSON.stringify({ version: 1, jobId, url: sourceUrl, createdAt: new Date().toISOString() });
  const requestPath = `${REQUEST_ROOT}/${jobId}.json`;
  const resultPath = `${RESULT_ROOT}/${jobId}.json`;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000), 180_000);
  const deadline = Date.now() + timeoutMs;

  options.onProgress?.('queued');
  const workflow = await githubRequest(connection, token.trim(), WORKFLOW_PATH, { method: 'GET' }, options.signal, true);
  if (workflow === null) {
    throw new GitHubImportError('The private data repository is missing Savor’s recipe-import workflow. Install or restore .github/workflows/savor-recipe-import.yml, then try again.');
  }
  await githubRequest(connection, token.trim(), requestPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Queue Savor recipe import ${jobId}`,
      content: encodeText(request),
      branch: connection.branch,
    }),
  }, options.signal);

  options.onProgress?.('reading');
  const readResult = async (): Promise<ImportResult | null> => {
    const file = await githubRequest(connection, token.trim(), resultPath, { method: 'GET' }, options.signal, true);
    if (file === null) return null;
    if (!isObject(file) || file.type !== 'file' || typeof file.content !== 'string') {
      throw new GitHubImportError('GitHub returned an unreadable recipe-import result.');
    }
    options.onProgress?.('structuring');
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(file.content));
    } catch {
      throw new GitHubImportError('GitHub returned an unreadable recipe-import result.');
    }
    const result = parseQueueResult(parsed, jobId, sourceUrl);
    return {
      draft: result.draft,
      warnings: result.warnings,
      provider: result.provider,
      sourcesChecked: result.sourcesChecked,
      completedAt: result.completedAt,
    };
  };
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    const result = await readResult();
    if (result) return result;
    await waitForPoll(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), options.signal);
  }

  const finalResult = await readResult();
  if (finalResult) return finalResult;

  throw new GitHubImportError(
    'GitHub did not finish extracting this recipe within two minutes. Check that the recipe-import workflow is enabled in the private data repository, then try again.',
  );
}

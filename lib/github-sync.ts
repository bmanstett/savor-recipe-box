import {
  readCachedMedia,
  saveCachedMedia,
  type LocalSnapshot,
  type StoredGitHubConnection,
  type Tombstones,
} from './client-cache';
import type { BootstrapData, GroceryItem, HouseholdPreferences, MealPlanEntry, Recipe } from './types';
import { isValidSkylightDeviceEmail } from './skylight';

const API_ROOT = 'https://api.github.com';
const STATE_FORMAT = 'savor-github-sync';
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 900_000;
const MEDIA_PREFIX = 'github-media:';

interface GitHubUser {
  login: string;
  name: string | null;
}

interface GitHubRepo {
  private: boolean;
  default_branch: string;
  permissions?: { push?: boolean };
}

interface GitHubContents {
  type: 'file';
  sha: string;
  content?: string;
  encoding?: string;
}

interface RemoteDocument {
  format: typeof STATE_FORMAT;
  version: typeof STATE_VERSION;
  updatedAt: string;
  preferencesUpdatedAt: string;
  deviceId: string;
  data: BootstrapData;
  tombstones: Tombstones;
}

export interface GitHubConnectResult {
  connection: StoredGitHubConnection;
  displayName: string;
}

export class GitHubSyncError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
  }
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''));
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function encodeText(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function decodeText(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function isImageReference(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 1_300_000) return false;
  if (/^\.\/recipes\/[A-Za-z0-9_.-]+$/.test(value)) return true;
  if (/^github-media:savor\/v1\/media\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(value)) return true;
  if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return true;
  return isHttpUrl(value);
}

function assertBootstrapData(value: unknown): asserts value is BootstrapData {
  if (!isObject(value) || !Array.isArray(value.recipes) || !Array.isArray(value.mealPlan) || !Array.isArray(value.groceryItems)) {
    throw new GitHubSyncError('The GitHub data file is not a valid Savor household file.');
  }
  if (!isObject(value.preferences) || !Array.isArray(value.preferences.pantryStaples) || !Array.isArray(value.preferences.sectionOrder)) {
    throw new GitHubSyncError('The GitHub data file has invalid household preferences.');
  }
  const validRecipes = value.recipes.every((row) => {
    if (!isObject(row) || typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.description !== 'string') return false;
    if (!Array.isArray(row.ingredients) || !Array.isArray(row.instructions) || !Array.isArray(row.attachments) || !Array.isArray(row.tags) || !Array.isArray(row.categories)) return false;
    if (!isImageReference(row.heroImage) || !isHttpUrl(row.sourceURL)) return false;
    const ingredients = row.ingredients.every((item) => isObject(item) && typeof item.id === 'string' && typeof item.rawText === 'string' && typeof item.ingredientName === 'string' && typeof item.normalizedIngredient === 'string');
    const instructions = row.instructions.every((item) => isObject(item) && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.stepNumber === 'number');
    const attachments = row.attachments.every((item) => isObject(item) && typeof item.id === 'string' && typeof item.url === 'string' && isImageReference(item.url));
    return ingredients && instructions && attachments;
  });
  const validMeals = value.mealPlan.every((row) => isObject(row) && typeof row.id === 'string' && typeof row.recipeId === 'string' && typeof row.date === 'string' && typeof row.dateModified === 'string');
  const validGroceries = value.groceryItems.every((row) => isObject(row) && typeof row.id === 'string' && typeof row.ingredientName === 'string' && typeof row.normalizedIngredient === 'string' && typeof row.dateModified === 'string' && Array.isArray(row.recipeContributions));
  const skylightEmail = value.preferences.skylightDeviceEmail;
  const validSkylightEmail = skylightEmail === undefined || skylightEmail === null
    || (typeof skylightEmail === 'string' && isValidSkylightDeviceEmail(skylightEmail));
  const validPreferences = value.preferences.pantryStaples.every((item) => typeof item === 'string') && value.preferences.sectionOrder.every((item) => typeof item === 'string') && typeof value.preferences.excludePantryStaples === 'boolean' && validSkylightEmail;
  if (!validRecipes || !validMeals || !validGroceries) throw new GitHubSyncError('The GitHub data file contains invalid records.');
  if (!validPreferences) throw new GitHubSyncError('The GitHub data file contains invalid preferences.');
}

function assertRemoteDocument(value: unknown): asserts value is RemoteDocument {
  if (!isObject(value) || value.format !== STATE_FORMAT || value.version !== STATE_VERSION || typeof value.updatedAt !== 'string') {
    throw new GitHubSyncError('The private repository contains an unsupported Savor data format.');
  }
  assertBootstrapData(value.data);
  if (!isObject(value.tombstones)) throw new GitHubSyncError('The Savor data file is missing deletion history.');
  if (typeof value.preferencesUpdatedAt !== 'string') value.preferencesUpdatedAt = value.updatedAt;
}

class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
    private readonly branch: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, allowMissing = false): Promise<T | null> {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      const rateLimited = response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0');
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0);
      const resetLabel = reset ? new Date(reset * 1_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      const friendly = rateLimited
        ? `GitHub’s API limit was reached. Your local changes are safe${resetLabel ? `; try again after ${resetLabel}` : ' and can be synced later'}.`
        : response.status === 401
        ? 'That GitHub token is invalid or expired.'
        : response.status === 403
          ? 'GitHub denied access. Check that this token has Contents read/write access to only the private data repository.'
          : response.status === 404
            ? 'GitHub could not find that repository with this token.'
            : response.status === 409
              ? 'The GitHub data changed on another device.'
              : payload.message || 'GitHub sync failed.';
      throw new GitHubSyncError(friendly, rateLimited ? 429 : response.status);
    }
    if (response.status === 204) return null;
    return await response.json() as T;
  }

  getUser(): Promise<GitHubUser | null> {
    return this.request<GitHubUser>('/user');
  }

  getRepo(): Promise<GitHubRepo | null> {
    return this.request<GitHubRepo>(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`);
  }

  getFile(path: string): Promise<GitHubContents | null> {
    return this.request<GitHubContents>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath(path)}?ref=${encodeURIComponent(this.branch)}`,
      {},
      true,
    );
  }

  putFile(path: string, content: string, message: string, sha?: string): Promise<unknown> {
    return this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath(path)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content, branch: this.branch, ...(sha ? { sha } : {}) }),
      },
    );
  }
}

export async function validateGitHubConnection(token: string, owner: string, repo: string): Promise<GitHubConnectResult> {
  const cleanToken = token.trim();
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  if (!cleanToken || !cleanOwner || !cleanRepo) throw new GitHubSyncError('Enter the repository owner, repository name, and fine-grained token.');
  if (!/^[A-Za-z0-9_.-]+$/.test(cleanOwner) || !/^[A-Za-z0-9_.-]+$/.test(cleanRepo)) throw new GitHubSyncError('Enter a valid GitHub owner and repository name.');

  const temporary = new GitHubClient(cleanToken, cleanOwner, cleanRepo, 'HEAD');
  const [user, repository] = await Promise.all([temporary.getUser(), temporary.getRepo()]);
  if (!user || !repository) throw new GitHubSyncError('GitHub could not verify this connection.');
  if (!repository.private) throw new GitHubSyncError('Choose a private repository for household data. The Pages app repository must stay separate.');
  if (!repository.permissions?.push) throw new GitHubSyncError('This token cannot write to the data repository. Give it Contents read/write permission.');

  const now = new Date().toISOString();
  return {
    displayName: user.name?.trim() || user.login,
    connection: {
      owner: cleanOwner,
      repo: cleanRepo,
      branch: repository.default_branch,
      filePath: 'savor/v1/state.json',
      username: user.login,
      connectedAt: now,
      lastSyncAt: null,
    },
  };
}

function newestTimestamp(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function sameValue(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function combineTombstones(local: Tombstones, remote: Tombstones): Tombstones {
  const combine = (first: Record<string, string>, second: Record<string, string>) => {
    const output: Record<string, string> = { ...first };
    for (const [id, value] of Object.entries(second)) output[id] = newestTimestamp(output[id], value) ?? value;
    return output;
  };
  return {
    recipes: combine(local.recipes ?? {}, remote.recipes ?? {}),
    mealPlan: combine(local.mealPlan ?? {}, remote.mealPlan ?? {}),
    groceryItems: combine(local.groceryItems ?? {}, remote.groceryItems ?? {}),
  };
}

function rowTimestamp(value: { dateModified?: string; dateAdded?: string }): string {
  return value.dateModified || value.dateAdded || '1970-01-01T00:00:00.000Z';
}

function mergeRows<T extends { id: string; dateModified?: string; dateAdded?: string }>(
  local: T[],
  remote: T[],
  tombstones: Record<string, string>,
): T[] {
  const rows = new Map<string, T>();
  for (const row of [...remote, ...local]) {
    const current = rows.get(row.id);
    if (!current || rowTimestamp(row) >= rowTimestamp(current)) rows.set(row.id, row);
  }
  return [...rows.values()].filter((row) => !tombstones[row.id] || tombstones[row.id] < rowTimestamp(row));
}

interface EntityState<T> {
  row?: T;
  tombstone?: string;
}

function entityState<T extends { dateModified?: string; dateAdded?: string }>(row: T | undefined, tombstone: string | undefined): EntityState<T> {
  if (tombstone && (!row || tombstone >= rowTimestamp(row))) return { tombstone };
  return row ? { row } : {};
}

function mergeCollection<T extends { id: string; dateModified?: string; dateAdded?: string }>(
  baseRows: T[] | undefined,
  localRows: T[],
  remoteRows: T[],
  baseTombstones: Record<string, string> | undefined,
  localTombstones: Record<string, string>,
  remoteTombstones: Record<string, string>,
  conflictCopy: (row: T) => T,
): { rows: T[]; tombstones: Record<string, string> } {
  if (!baseRows || !baseTombstones) {
    const tombstones = combineTombstones(
      { recipes: localTombstones, mealPlan: {}, groceryItems: {} },
      { recipes: remoteTombstones, mealPlan: {}, groceryItems: {} },
    ).recipes;
    return { rows: mergeRows(localRows, remoteRows, tombstones), tombstones };
  }
  const baseMap = new Map(baseRows.map((row) => [row.id, row]));
  const localMap = new Map(localRows.map((row) => [row.id, row]));
  const remoteMap = new Map(remoteRows.map((row) => [row.id, row]));
  const ids = new Set([
    ...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys(),
    ...Object.keys(baseTombstones), ...Object.keys(localTombstones), ...Object.keys(remoteTombstones),
  ]);
  const output = new Map<string, T>();
  const tombstones: Record<string, string> = {};

  for (const id of ids) {
    const base = entityState(baseMap.get(id), baseTombstones[id]);
    const local = entityState(localMap.get(id), localTombstones[id]);
    const remote = entityState(remoteMap.get(id), remoteTombstones[id]);
    let chosen: EntityState<T>;
    if (sameValue(local, base)) chosen = remote;
    else if (sameValue(remote, base) || sameValue(local, remote)) chosen = local;
    else if (!local.row && !remote.row) {
      chosen = { tombstone: newestTimestamp(local.tombstone, remote.tombstone) };
    } else if (!local.row || !remote.row) {
      chosen = !local.row ? local : remote;
      const edited = local.row ?? remote.row;
      if (edited) {
        const conflict = conflictCopy(edited);
        output.set(conflict.id, conflict);
      }
    } else {
      chosen = remote;
      const conflict = conflictCopy(local.row);
      output.set(conflict.id, conflict);
    }
    if (chosen.row) output.set(id, chosen.row);
    else if (chosen.tombstone) tombstones[id] = chosen.tombstone;
  }
  return { rows: [...output.values()], tombstones };
}

function threeWayValue<T>(base: T, local: T, remote: T): T {
  if (sameValue(local, base)) return remote;
  if (sameValue(remote, base) || sameValue(local, remote)) return local;
  return local;
}

function mergePreferences(base: HouseholdPreferences | undefined, local: HouseholdPreferences, remote: HouseholdPreferences): HouseholdPreferences {
  if (!base) return local;
  return {
    pantryStaples: threeWayValue(base.pantryStaples, local.pantryStaples, remote.pantryStaples),
    sectionOrder: threeWayValue(base.sectionOrder, local.sectionOrder, remote.sectionOrder),
    excludePantryStaples: threeWayValue(base.excludePantryStaples, local.excludePantryStaples, remote.excludePantryStaples),
    skylightDeviceEmail: threeWayValue(base.skylightDeviceEmail ?? null, local.skylightDeviceEmail ?? null, remote.skylightDeviceEmail ?? null),
  };
}

function mergeDocuments(local: RemoteDocument, remote: RemoteDocument, base?: RemoteDocument): RemoteDocument {
  const now = new Date().toISOString();
  const suffix = local.deviceId.replace(/[^A-Za-z0-9]/g, '').slice(-12) || 'device';
  const recipes = mergeCollection(
    base?.data.recipes, local.data.recipes, remote.data.recipes,
    base?.tombstones.recipes, local.tombstones.recipes, remote.tombstones.recipes,
    (row) => ({
      ...row,
      id: `${row.id.slice(0, 120)}_conflict_${suffix}`,
      title: `${row.title} — conflict copy`,
      notes: `${row.notes}${row.notes ? '\n\n' : ''}Preserved after concurrent edits on two devices.`,
      dateModified: now,
      revision: row.revision + 1,
    }),
  );
  const mealPlan = mergeCollection(
    base?.data.mealPlan, local.data.mealPlan, remote.data.mealPlan,
    base?.tombstones.mealPlan, local.tombstones.mealPlan, remote.tombstones.mealPlan,
    (row) => ({ ...row, id: `${row.id.slice(0, 120)}_conflict_${suffix}`, dateModified: now, revision: row.revision + 1 }),
  );
  const groceryItems = mergeCollection(
    base?.data.groceryItems, local.data.groceryItems, remote.data.groceryItems,
    base?.tombstones.groceryItems, local.tombstones.groceryItems, remote.tombstones.groceryItems,
    (row) => ({
      ...row,
      id: `${row.id.slice(0, 120)}_conflict_${suffix}`,
      ingredientName: `${row.ingredientName} (conflict)`,
      dateModified: now,
      revision: row.revision + 1,
    }),
  );
  const preferences = base
    ? mergePreferences(base.data.preferences, local.data.preferences, remote.data.preferences)
    : local.preferencesUpdatedAt >= remote.preferencesUpdatedAt ? local.data.preferences : remote.data.preferences;
  const preferencesUpdatedAt = base
    ? newestTimestamp(local.preferencesUpdatedAt, remote.preferencesUpdatedAt) ?? now
    : local.preferencesUpdatedAt >= remote.preferencesUpdatedAt ? local.preferencesUpdatedAt : remote.preferencesUpdatedAt;
  const data: BootstrapData = {
    recipes: recipes.rows.sort((a, b) => b.dateModified.localeCompare(a.dateModified)),
    mealPlan: mealPlan.rows.sort((a, b) => a.date.localeCompare(b.date)),
    groceryItems: groceryItems.rows,
    preferences,
    user: local.data.user,
    syncedAt: now,
  };
  return {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    updatedAt: now,
    preferencesUpdatedAt,
    deviceId: local.deviceId,
    data,
    tombstones: { recipes: recipes.tombstones, mealPlan: mealPlan.tombstones, groceryItems: groceryItems.tombstones },
  };
}

function snapshotDocument(snapshot: LocalSnapshot): RemoteDocument {
  return {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    updatedAt: snapshot.updatedAt,
    preferencesUpdatedAt: snapshot.preferencesUpdatedAt,
    deviceId: snapshot.deviceId,
    data: snapshot.data,
    tombstones: snapshot.tombstones,
  };
}

function snapshotBaseDocument(snapshot: LocalSnapshot): RemoteDocument | undefined {
  if (!snapshot.baseData || !snapshot.baseTombstones) return undefined;
  return {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    updatedAt: snapshot.data.syncedAt,
    preferencesUpdatedAt: snapshot.basePreferencesUpdatedAt ?? snapshot.preferencesUpdatedAt,
    deviceId: snapshot.deviceId,
    data: snapshot.baseData,
    tombstones: snapshot.baseTombstones,
  };
}

function parseDataUrl(value: string): { mimeType: string; base64: string } | null {
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function uploadMedia(client: GitHubClient, dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return dataUrl;
  const bytes = base64ToBytes(parsed.base64);
  if (bytes.byteLength > 950_000) throw new GitHubSyncError('One attached image is still too large to sync. Reattach a smaller copy.');
  const extension = parsed.mimeType === 'image/png' ? 'png' : parsed.mimeType === 'image/webp' ? 'webp' : 'jpg';
  const path = `savor/v1/media/${await digestHex(bytes)}.${extension}`;
  const existing = await client.getFile(path);
  if (!existing) {
    try {
      await client.putFile(path, parsed.base64, 'Sync Savor media');
    } catch (error) {
      if (!(error instanceof GitHubSyncError) || ![409, 422].includes(error.status)) throw error;
      const concurrent = await client.getFile(path);
      if (!concurrent) throw new GitHubSyncError('A concurrent photo upload could not be verified. Try syncing again.', error.status);
    }
  }
  await saveCachedMedia(path, dataUrl).catch(() => undefined);
  return `${MEDIA_PREFIX}${path}`;
}

async function prepareMedia(document: RemoteDocument, client: GitHubClient): Promise<RemoteDocument> {
  const copy = structuredClone(document);
  const mapped = new Map<string, string>();
  const convert = async (value: string | null) => {
    if (!value?.startsWith('data:image/')) return value;
    const cached = mapped.get(value);
    if (cached) return cached;
    const next = await uploadMedia(client, value);
    mapped.set(value, next);
    return next;
  };
  for (const recipe of copy.data.recipes) {
    recipe.heroImage = await convert(recipe.heroImage);
    for (const attachment of recipe.attachments) attachment.url = (await convert(attachment.url)) ?? attachment.url;
  }
  return copy;
}

async function downloadMedia(client: GitHubClient, reference: string): Promise<string | null> {
  if (!reference.startsWith(MEDIA_PREFIX)) return reference;
  const path = reference.slice(MEDIA_PREFIX.length);
  if (!/^savor\/v1\/media\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(path)) return null;
  const cached = await readCachedMedia(path).catch(() => null);
  if (cached) return cached;
  const file = await client.getFile(path);
  if (!file?.content) return null;
  const mimeType = path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${file.content.replace(/\s/g, '')}`;
  await saveCachedMedia(path, dataUrl).catch(() => undefined);
  return dataUrl;
}

async function hydrateMedia(document: RemoteDocument, client: GitHubClient): Promise<RemoteDocument> {
  const copy = structuredClone(document);
  for (const recipe of copy.data.recipes) {
    recipe.heroImage = await downloadMedia(client, recipe.heroImage ?? '');
    for (const attachment of recipe.attachments) attachment.url = (await downloadMedia(client, attachment.url)) ?? '';
    recipe.attachments = recipe.attachments.filter((attachment) => Boolean(attachment.url));
  }
  return copy;
}

async function readRemoteDocument(client: GitHubClient, connection: StoredGitHubConnection): Promise<{ document: RemoteDocument | null; sha?: string }> {
  const file = await client.getFile(connection.filePath);
  if (!file) return { document: null };
  if (!file.content) throw new GitHubSyncError('The Savor data file is too large for direct sync.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(file.content));
  } catch {
    throw new GitHubSyncError('The Savor data file is not valid JSON.');
  }
  assertRemoteDocument(parsed);
  return { document: await hydrateMedia(parsed, client), sha: file.sha };
}

export async function syncGitHubSnapshot(
  snapshot: LocalSnapshot,
  connection: StoredGitHubConnection,
  token: string,
): Promise<{ snapshot: LocalSnapshot; connection: StoredGitHubConnection }> {
  const client = new GitHubClient(token, connection.owner, connection.repo, connection.branch);
  let lastConflict: GitHubSyncError | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remote = await readRemoteDocument(client, connection);
    const localDocument = snapshotDocument(snapshot);
    const baseDocument = snapshotBaseDocument(snapshot);
    const merged = remote.document
      ? snapshot.initialized
        ? mergeDocuments(localDocument, remote.document, baseDocument)
        : {
            ...remote.document,
            updatedAt: new Date().toISOString(),
            deviceId: snapshot.deviceId,
            data: { ...remote.document.data, user: snapshot.data.user },
          }
      : localDocument;
    const prepared = await prepareMedia(merged, client);
    const serialized = JSON.stringify(prepared);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
      throw new GitHubSyncError('Your Savor data file is approaching GitHub’s safe sync limit. Export a backup before adding more content.');
    }
    try {
      await client.putFile(connection.filePath, encodeText(serialized), 'Sync Savor household data', remote.sha);
      const syncedAt = new Date().toISOString();
      return {
        snapshot: {
          data: { ...merged.data, syncedAt },
          tombstones: merged.tombstones,
          deviceId: snapshot.deviceId,
          updatedAt: syncedAt,
          preferencesUpdatedAt: merged.preferencesUpdatedAt,
          initialized: true,
          dirty: false,
          baseData: structuredClone(merged.data),
          baseTombstones: structuredClone(merged.tombstones),
          basePreferencesUpdatedAt: merged.preferencesUpdatedAt,
        },
        connection: { ...connection, lastSyncAt: syncedAt },
      };
    } catch (error) {
      if (!(error instanceof GitHubSyncError) || ![409, 422].includes(error.status)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict ?? new GitHubSyncError('GitHub sync could not resolve a concurrent update. Try again.');
}

export function parseBackupFile(value: unknown, fallbackUser: BootstrapData['user']): BootstrapData {
  if (!isObject(value)) throw new GitHubSyncError('This backup is not a Savor JSON file.');
  if (value.format !== undefined && value.format !== 'savor-household-backup') throw new GitHubSyncError('This JSON file is not a Savor backup.');
  if (value.version !== undefined && value.version !== 1) throw new GitHubSyncError('This Savor backup version is not supported.');
  const candidate = isObject(value.data) ? value.data : value;
  assertBootstrapData(candidate);
  const copy = structuredClone(candidate);
  copy.user = fallbackUser;
  return copy;
}

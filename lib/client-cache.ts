import type { BootstrapData } from './types';
import { aggregateRecipes, makeId, parseIngredientLine } from './domain';
import type { GroceryItem, MealPlanEntry, Recipe } from './types';

const DB_NAME = 'savor-local-cache';
const DB_VERSION = 2;
const STATE_STORE = 'state';
const MEDIA_STORE = 'media';
const LEGACY_QUEUE_STORE = 'mutation-queue';

export interface Tombstones {
  recipes: Record<string, string>;
  mealPlan: Record<string, string>;
  groceryItems: Record<string, string>;
}

export interface LocalSnapshot {
  data: BootstrapData;
  tombstones: Tombstones;
  deviceId: string;
  updatedAt: string;
  preferencesUpdatedAt: string;
  initialized: boolean;
  dirty: boolean;
  baseData?: BootstrapData;
  baseTombstones?: Tombstones;
  basePreferencesUpdatedAt?: string;
}

export interface StoredGitHubConnection {
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
  username: string;
  connectedAt: string;
  lastSyncAt: string | null;
}

export const EMPTY_TOMBSTONES: Tombstones = {
  recipes: {},
  mealPlan: {},
  groceryItems: {},
};

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE);
      // Preserve the legacy queue until its optimistic state has been exported or
      // migrated. Static Savor never replays retired `/api/*` requests.
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readValue<T>(store: string, key: IDBValidKey): Promise<T | null> {
  const db = await openCache();
  const value = await new Promise<T | null>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => { db.close(); reject(request.error); };
  });
  db.close();
  return value;
}

async function readAllValues<T>(store: string): Promise<T[]> {
  const db = await openCache();
  if (!db.objectStoreNames.contains(store)) { db.close(); return []; }
  const values = await new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => { db.close(); reject(request.error); };
  });
  db.close();
  return values;
}

interface LegacyMutation {
  url: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  createdAt?: string;
}

function applyLegacyMutations(source: BootstrapData, mutations: LegacyMutation[]): BootstrapData {
  let data = structuredClone(source);
  const upsert = <T extends { id: string }>(rows: T[], row: T) => [row, ...rows.filter((item) => item.id !== row.id)];
  for (const mutation of mutations) {
    const body = mutation.body && typeof mutation.body === 'object' ? mutation.body as Record<string, unknown> : {};
    const changedAt = mutation.createdAt ?? new Date().toISOString();
    if (mutation.url === '/api/recipes' && mutation.method === 'POST' && typeof body.id === 'string') {
      data.recipes = upsert(data.recipes, body as unknown as Recipe);
      continue;
    }
    const recipeMatch = mutation.url.match(/^\/api\/recipes\/([^/]+)$/);
    if (recipeMatch) {
      if (mutation.method === 'DELETE') data.recipes = data.recipes.filter((row) => row.id !== recipeMatch[1]);
      else data.recipes = data.recipes.map((row) => row.id === recipeMatch[1] ? { ...row, ...body, dateModified: changedAt, revision: row.revision + 1 } : row);
      continue;
    }
    if (mutation.url === '/api/meal-plan' && mutation.method === 'POST' && typeof body.id === 'string') {
      data.mealPlan = upsert(data.mealPlan, body as unknown as MealPlanEntry);
      continue;
    }
    const mealMatch = mutation.url.match(/^\/api\/meal-plan\/([^/]+)$/);
    if (mealMatch && mutation.method === 'DELETE') {
      data.mealPlan = data.mealPlan.filter((row) => row.id !== mealMatch[1]);
      continue;
    }
    if (mutation.url === '/api/grocery/generate' && mutation.method === 'POST' && Array.isArray(body.recipeIds)) {
      const recipeIds = body.recipeIds.filter((id): id is string => typeof id === 'string');
      const selected = data.recipes.filter((recipe) => recipeIds.includes(recipe.id));
      const generated = aggregateRecipes(
        selected,
        (body.servingsByRecipe ?? {}) as Record<string, number | null>,
        data.preferences.excludePantryStaples ? data.preferences.pantryStaples : [],
        Array.isArray(body.occurrences) ? body.occurrences as Array<{ recipeId: string; servings: number | null }> : [],
      );
      data.groceryItems = [...generated, ...data.groceryItems.filter((item) => item.manual)];
      continue;
    }
    if (mutation.url === '/api/grocery' && mutation.method === 'POST' && typeof body.rawText === 'string') {
      const ingredient = parseIngredientLine(body.rawText);
      const item: GroceryItem = {
        id: typeof body.id === 'string' ? body.id : makeId('grocery'),
        ingredientName: ingredient.ingredientName,
        normalizedIngredient: ingredient.normalizedIngredient,
        quantity: ingredient.quantity,
        unit: ingredient.normalizedUnit,
        groceryCategory: ingredient.groceryCategory,
        checked: false,
        manual: true,
        recipeContributions: [],
        revision: 1,
        dateModified: changedAt,
      };
      data.groceryItems = upsert(data.groceryItems, item);
      continue;
    }
    const groceryMatch = mutation.url.match(/^\/api\/grocery\/([^/]+)$/);
    if (groceryMatch) {
      if (mutation.method === 'DELETE') data.groceryItems = data.groceryItems.filter((row) => row.id !== groceryMatch[1]);
      else data.groceryItems = data.groceryItems.map((row) => row.id === groceryMatch[1] ? { ...row, ...body, dateModified: changedAt, revision: row.revision + 1 } : row);
      continue;
    }
    if (mutation.url === '/api/preferences' && mutation.method === 'PUT') {
      data = { ...data, preferences: body as unknown as BootstrapData['preferences'] };
    }
  }
  return data;
}

async function writeValue(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openCache();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
  db.close();
}

async function deleteValue(store: string, key: IDBValidKey): Promise<void> {
  const db = await openCache();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    transaction.objectStore(store).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
  db.close();
}

export async function readLocalSnapshot(): Promise<LocalSnapshot | null> {
  const snapshot = await readValue<LocalSnapshot>(STATE_STORE, 'snapshot');
  if (snapshot) {
    return {
      ...snapshot,
      preferencesUpdatedAt: snapshot.preferencesUpdatedAt ?? snapshot.updatedAt,
      initialized: snapshot.initialized ?? true,
    };
  }
  const legacy = await readValue<BootstrapData>(STATE_STORE, 'bootstrap');
  if (!legacy) return null;
  const mutations = await readAllValues<LegacyMutation>(LEGACY_QUEUE_STORE);
  const now = new Date().toISOString();
  return {
    data: applyLegacyMutations(legacy, mutations),
    tombstones: structuredClone(EMPTY_TOMBSTONES),
    deviceId: `device_${crypto.randomUUID()}`,
    updatedAt: now,
    preferencesUpdatedAt: now,
    initialized: true,
    dirty: true,
  };
}

export function saveLocalSnapshot(snapshot: LocalSnapshot): Promise<void> {
  return writeValue(STATE_STORE, 'snapshot', snapshot);
}

export function readGitHubConnection(): Promise<StoredGitHubConnection | null> {
  return readValue<StoredGitHubConnection>(STATE_STORE, 'github-connection');
}

export function saveGitHubConnection(connection: StoredGitHubConnection): Promise<void> {
  return writeValue(STATE_STORE, 'github-connection', connection);
}

export function clearGitHubConnection(): Promise<void> {
  return deleteValue(STATE_STORE, 'github-connection');
}

export function readCachedMedia(path: string): Promise<string | null> {
  return readValue<string>(MEDIA_STORE, path);
}

export function saveCachedMedia(path: string, dataUrl: string): Promise<void> {
  return writeValue(MEDIA_STORE, path, dataUrl);
}

export async function clearAllLocalData(): Promise<void> {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('savor-')).map((key) => caches.delete(key)));
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Local storage is still open in another Savor tab.'));
  });
}

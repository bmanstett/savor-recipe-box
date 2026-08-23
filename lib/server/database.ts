import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getDb } from '../../db';
import { attachments, groceryItems, householdPreferences, mealPlanEntries, recipes } from '../../db/schema';
import { SEED_GROCERY_ITEMS, SEED_MEAL_PLAN, SEED_PREFERENCES, SEED_RECIPES } from '../seed';
import type {
  BootstrapData,
  GroceryItem,
  HouseholdPreferences,
  MealPlanEntry,
  Recipe,
} from '../types';

export const HOUSEHOLD_ID = 'our-kitchen';

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  schemaReady ??= initializeSchema();
  return schemaReady;
}

async function initializeSchema(): Promise<void> {
  const d1 = env.DB;
  if (!d1) throw new Error('Recipe storage is unavailable.');
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      hero_image TEXT,
      source_type TEXT NOT NULL,
      source_url TEXT,
      source_name TEXT,
      author TEXT,
      servings INTEGER,
      prep_time INTEGER,
      cook_time INTEGER,
      total_time INTEGER,
      cuisine TEXT,
      categories TEXT NOT NULL,
      tags TEXT NOT NULL,
      ingredients TEXT NOT NULL,
      instructions TEXT NOT NULL,
      rating INTEGER,
      favorite INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL,
      date_added TEXT NOT NULL,
      date_modified TEXT NOT NULL,
      last_cooked TEXT,
      times_cooked INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS meal_plan_entries (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      date TEXT NOT NULL,
      meal_type TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      servings INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      date_modified TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS grocery_items (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      ingredient_name TEXT NOT NULL,
      normalized_ingredient TEXT NOT NULL,
      quantity TEXT,
      unit TEXT,
      grocery_category TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      manual INTEGER NOT NULL DEFAULT 0,
      recipe_contributions TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      date_modified TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS household_preferences (
      household_id TEXT PRIMARY KEY NOT NULL,
      preferences TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      date_modified TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      recipe_id TEXT,
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_recipes_household_modified ON recipes (household_id, date_modified)'),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_recipes_household_title ON recipes (household_id, title)'),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_meal_plan_household_date ON meal_plan_entries (household_id, date)'),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_meal_plan_recipe ON meal_plan_entries (recipe_id)'),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_grocery_household_category ON grocery_items (household_id, grocery_category, sort_order)'),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_attachments_household_recipe ON attachments (household_id, recipe_id)'),
    d1.prepare('PRAGMA optimize'),
  ]);
}

function recipeValues(recipe: Recipe) {
  return { ...recipe, householdId: HOUSEHOLD_ID };
}

function mealValues(entry: MealPlanEntry) {
  return { ...entry, householdId: HOUSEHOLD_ID };
}

function groceryValues(item: GroceryItem, sortOrder = 0) {
  return { ...item, householdId: HOUSEHOLD_ID, sortOrder };
}

async function seedIfEmpty(): Promise<void> {
  const db = getDb();
  const preferencesRows = await db.select().from(householdPreferences)
    .where(eq(householdPreferences.householdId, HOUSEHOLD_ID)).limit(1);
  if (preferencesRows.length) return;
  for (const recipe of SEED_RECIPES) {
    await db.insert(recipes).values(recipeValues(recipe)).onConflictDoNothing();
  }
  for (const entry of SEED_MEAL_PLAN) {
    await db.insert(mealPlanEntries).values(mealValues(entry)).onConflictDoNothing();
  }
  for (const [index, item] of SEED_GROCERY_ITEMS.entries()) {
    await db.insert(groceryItems).values(groceryValues(item, index)).onConflictDoNothing();
  }
  await db.insert(householdPreferences).values({
    householdId: HOUSEHOLD_ID,
    preferences: SEED_PREFERENCES,
    revision: 1,
    dateModified: new Date().toISOString(),
  }).onConflictDoNothing();
}

export async function getBootstrapData(user: BootstrapData['user']): Promise<BootstrapData> {
  await ensureSchema();
  await seedIfEmpty();
  const db = getDb();
  const [recipeRows, mealRows, groceryRows, preferenceRows] = await Promise.all([
    db.select().from(recipes)
      .where(and(eq(recipes.householdId, HOUSEHOLD_ID), isNull(recipes.deletedAt)))
      .orderBy(desc(recipes.dateModified)),
    db.select().from(mealPlanEntries)
      .where(eq(mealPlanEntries.householdId, HOUSEHOLD_ID))
      .orderBy(asc(mealPlanEntries.date)),
    db.select().from(groceryItems)
      .where(eq(groceryItems.householdId, HOUSEHOLD_ID))
      .orderBy(asc(groceryItems.groceryCategory), asc(groceryItems.sortOrder)),
    db.select().from(householdPreferences).where(eq(householdPreferences.householdId, HOUSEHOLD_ID)),
  ]);
  return {
    recipes: recipeRows.map(({ householdId: _householdId, ...recipe }) => recipe as Recipe),
    mealPlan: mealRows.map(({ householdId: _householdId, ...entry }) => entry as MealPlanEntry),
    groceryItems: groceryRows.map(({ householdId: _householdId, sortOrder: _sortOrder, ...item }) => item as GroceryItem),
    preferences: preferenceRows[0]?.preferences ?? SEED_PREFERENCES,
    user,
    syncedAt: new Date().toISOString(),
  };
}

export async function getRecipesByIds(ids: string[]): Promise<Recipe[]> {
  await ensureSchema();
  if (!ids.length) return [];
  const rows = await getDb().select().from(recipes).where(and(
    eq(recipes.householdId, HOUSEHOLD_ID),
    isNull(recipes.deletedAt),
    inArray(recipes.id, ids.slice(0, 100)),
  ));
  return rows.map(({ householdId: _householdId, ...recipe }) => recipe as Recipe);
}

export async function getPreferences(): Promise<HouseholdPreferences> {
  await ensureSchema();
  const rows = await getDb().select().from(householdPreferences)
    .where(eq(householdPreferences.householdId, HOUSEHOLD_ID)).limit(1);
  return rows[0]?.preferences ?? SEED_PREFERENCES;
}

export async function upsertRecipe(recipe: Recipe): Promise<Recipe> {
  await ensureSchema();
  const db = getDb();
  const existing = await db.select().from(recipes)
    .where(and(eq(recipes.householdId, HOUSEHOLD_ID), eq(recipes.id, recipe.id))).limit(1);
  const saved = {
    ...recipe,
    dateAdded: existing[0]?.dateAdded ?? recipe.dateAdded,
    dateModified: new Date().toISOString(),
    revision: (existing[0]?.revision ?? 0) + 1,
  };
  await db.insert(recipes).values(recipeValues(saved)).onConflictDoUpdate({
    target: recipes.id,
    set: recipeValues(saved),
  });
  return saved;
}

export async function patchRecipe(id: string, patch: Partial<Recipe>): Promise<Recipe | null> {
  await ensureSchema();
  const db = getDb();
  const rows = await db.select().from(recipes)
    .where(and(eq(recipes.householdId, HOUSEHOLD_ID), eq(recipes.id, id))).limit(1);
  if (!rows[0]) return null;
  const { householdId: _householdId, ...current } = rows[0];
  return upsertRecipe({ ...(current as Recipe), ...patch, id, dateModified: new Date().toISOString() });
}

export async function upsertMealEntry(entry: MealPlanEntry): Promise<MealPlanEntry> {
  await ensureSchema();
  const db = getDb();
  const saved = { ...entry, dateModified: new Date().toISOString() };
  await db.insert(mealPlanEntries).values(mealValues(saved)).onConflictDoUpdate({
    target: mealPlanEntries.id,
    set: mealValues(saved),
  });
  return saved;
}

export async function deleteMealEntry(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await getDb().delete(mealPlanEntries)
    .where(and(eq(mealPlanEntries.householdId, HOUSEHOLD_ID), eq(mealPlanEntries.id, id)));
  return Boolean(result.meta.changes);
}

export async function replaceGeneratedGroceryItems(items: GroceryItem[]): Promise<GroceryItem[]> {
  await ensureSchema();
  const db = getDb();
  const existing = await db.select().from(groceryItems).where(eq(groceryItems.householdId, HOUSEHOLD_ID));
  const checkedByKey = new Map(existing.map((item) => [`${item.normalizedIngredient}|${item.unit}`, item.checked]));
  const generated = items.map((item) => ({
    ...item,
    checked: checkedByKey.get(`${item.normalizedIngredient}|${item.unit}`) ?? false,
    dateModified: new Date().toISOString(),
  }));
  const replaceOperations = [
    db.delete(groceryItems).where(and(eq(groceryItems.householdId, HOUSEHOLD_ID), eq(groceryItems.manual, false))),
    ...generated.map((item, index) => db.insert(groceryItems).values(groceryValues(item, index))),
  ] as const;
  await db.batch(replaceOperations);
  const rows = await db.select().from(groceryItems)
    .where(eq(groceryItems.householdId, HOUSEHOLD_ID))
    .orderBy(asc(groceryItems.groceryCategory), asc(groceryItems.sortOrder));
  return rows.map(({ householdId: _householdId, sortOrder: _sortOrder, ...item }) => item as GroceryItem);
}

export async function upsertGroceryItem(item: GroceryItem): Promise<GroceryItem> {
  await ensureSchema();
  const db = getDb();
  const saved = { ...item, dateModified: new Date().toISOString(), revision: item.revision + 1 };
  await db.insert(groceryItems).values(groceryValues(saved)).onConflictDoUpdate({
    target: groceryItems.id,
    set: groceryValues(saved),
  });
  return saved;
}

export async function patchGroceryItem(id: string, patch: Partial<GroceryItem>): Promise<GroceryItem | null> {
  await ensureSchema();
  const db = getDb();
  const rows = await db.select().from(groceryItems)
    .where(and(eq(groceryItems.householdId, HOUSEHOLD_ID), eq(groceryItems.id, id))).limit(1);
  if (!rows[0]) return null;
  const { householdId: _householdId, sortOrder: _sortOrder, ...current } = rows[0];
  return upsertGroceryItem({ ...(current as GroceryItem), ...patch, id });
}

export async function deleteGroceryItem(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await getDb().delete(groceryItems)
    .where(and(eq(groceryItems.householdId, HOUSEHOLD_ID), eq(groceryItems.id, id)));
  return Boolean(result.meta.changes);
}

export async function savePreferences(preferences: HouseholdPreferences): Promise<HouseholdPreferences> {
  await ensureSchema();
  const now = new Date().toISOString();
  await getDb().insert(householdPreferences).values({
    householdId: HOUSEHOLD_ID, preferences, revision: 1, dateModified: now,
  }).onConflictDoUpdate({ target: householdPreferences.householdId, set: { preferences, dateModified: now, revision: sql`${householdPreferences.revision} + 1` } });
  return preferences;
}

export async function saveAttachmentMetadata(value: typeof attachments.$inferInsert): Promise<void> {
  await ensureSchema();
  await getDb().insert(attachments).values(value).onConflictDoNothing();
}

export async function mergeBackup(data: {
  recipes?: Recipe[];
  mealPlan?: MealPlanEntry[];
  groceryItems?: GroceryItem[];
  preferences?: HouseholdPreferences;
}): Promise<void> {
  await ensureSchema();
  const recipeRows = (data.recipes ?? []).slice(0, 500).map(recipeValues);
  const mealRows = (data.mealPlan ?? []).slice(0, 1000).map(mealValues);
  const groceryRows = (data.groceryItems ?? []).slice(0, 1000).map(groceryValues);
  const db = getDb();
  const now = new Date().toISOString();
  const operations = [
    ...recipeRows.map((row) => db.insert(recipes).values(row).onConflictDoNothing()),
    ...mealRows.map((row) => db.insert(mealPlanEntries).values(row).onConflictDoNothing()),
    ...groceryRows.map((row) => db.insert(groceryItems).values(row).onConflictDoNothing()),
    ...(data.preferences ? [db.insert(householdPreferences).values({
      householdId: HOUSEHOLD_ID, preferences: data.preferences, revision: 1, dateModified: now,
    }).onConflictDoUpdate({
      target: householdPreferences.householdId,
      set: { preferences: data.preferences, dateModified: now, revision: sql`${householdPreferences.revision} + 1` },
    })] : []),
  ];
  if (operations.length) {
    await db.batch(operations as [typeof operations[number], ...Array<typeof operations[number]>]);
  }
}

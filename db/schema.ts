import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  Attachment,
  GroceryCategory,
  HouseholdPreferences,
  Ingredient,
  Instruction,
  Rational,
  RecipeContribution,
} from '../lib/types';

export const recipes = sqliteTable('recipes', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  heroImage: text('hero_image'),
  sourceType: text('source_type').notNull(),
  sourceURL: text('source_url'),
  sourceName: text('source_name'),
  author: text('author'),
  servings: integer('servings'),
  prepTime: integer('prep_time'),
  cookTime: integer('cook_time'),
  totalTime: integer('total_time'),
  cuisine: text('cuisine'),
  categories: text('categories', { mode: 'json' }).$type<string[]>().notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
  ingredients: text('ingredients', { mode: 'json' }).$type<Ingredient[]>().notNull(),
  instructions: text('instructions', { mode: 'json' }).$type<Instruction[]>().notNull(),
  rating: integer('rating'),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes').notNull().default(''),
  attachments: text('attachments', { mode: 'json' }).$type<Attachment[]>().notNull(),
  dateAdded: text('date_added').notNull(),
  dateModified: text('date_modified').notNull(),
  lastCooked: text('last_cooked'),
  timesCooked: integer('times_cooked').notNull().default(0),
  revision: integer('revision').notNull().default(1),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_recipes_household_modified').on(table.householdId, table.dateModified),
  index('idx_recipes_household_title').on(table.householdId, table.title),
]);

export const mealPlanEntries = sqliteTable('meal_plan_entries', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull(),
  date: text('date').notNull(),
  mealType: text('meal_type').notNull(),
  recipeId: text('recipe_id').notNull(),
  servings: integer('servings'),
  revision: integer('revision').notNull().default(1),
  dateModified: text('date_modified').notNull(),
}, (table) => [
  index('idx_meal_plan_household_date').on(table.householdId, table.date),
  index('idx_meal_plan_recipe').on(table.recipeId),
]);

export const groceryItems = sqliteTable('grocery_items', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull(),
  ingredientName: text('ingredient_name').notNull(),
  normalizedIngredient: text('normalized_ingredient').notNull(),
  quantity: text('quantity', { mode: 'json' }).$type<Rational | null>(),
  unit: text('unit'),
  groceryCategory: text('grocery_category').$type<GroceryCategory>().notNull(),
  checked: integer('checked', { mode: 'boolean' }).notNull().default(false),
  manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
  recipeContributions: text('recipe_contributions', { mode: 'json' }).$type<RecipeContribution[]>().notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  revision: integer('revision').notNull().default(1),
  dateModified: text('date_modified').notNull(),
}, (table) => [
  index('idx_grocery_household_category').on(table.householdId, table.groceryCategory, table.sortOrder),
]);

export const householdPreferences = sqliteTable('household_preferences', {
  householdId: text('household_id').primaryKey(),
  preferences: text('preferences', { mode: 'json' }).$type<HouseholdPreferences>().notNull(),
  revision: integer('revision').notNull().default(1),
  dateModified: text('date_modified').notNull(),
});

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull(),
  recipeId: text('recipe_id'),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull(),
  originalFilename: text('original_filename').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_attachments_household_recipe').on(table.householdId, table.recipeId),
]);

export type SourceType = 'url' | 'photo' | 'screenshot' | 'pasted-text' | 'manual';
export const MEAL_TYPES = ['breakfast', 'lunch', 'snack', 'dinner'] as const;
export type MealType = (typeof MEAL_TYPES)[number];
export type SkylightEmailApp = 'gmail' | 'device-default';
export type GroceryCategory =
  | 'Produce'
  | 'Meat & Seafood'
  | 'Dairy & Eggs'
  | 'Bakery'
  | 'Frozen'
  | 'Pantry'
  | 'Canned & Jarred'
  | 'Pasta, Rice & Grains'
  | 'Spices & Seasonings'
  | 'Sauces & Condiments'
  | 'Other';

export interface Rational {
  numerator: number;
  denominator: number;
}

export interface Ingredient {
  id: string;
  rawText: string;
  quantity: Rational | null;
  unit: string | null;
  normalizedUnit: string | null;
  ingredientName: string;
  normalizedIngredient: string;
  descriptor: string | null;
  preparation: string | null;
  groceryCategory: GroceryCategory;
  optional: boolean;
  section: string | null;
  confidence: number;
  needsReview: boolean;
}

export interface Instruction {
  id: string;
  stepNumber: number;
  section: string | null;
  text: string;
  timerMinutes: number | null;
}

export interface Attachment {
  id: string;
  type: 'original-photo' | 'screenshot' | 'other';
  url: string;
  mimeType: string;
  originalFilename: string;
  captureDate: string;
}

export type RecipeSourceLinkKind = 'instagram-post' | 'creator-profile' | 'recipe-page';

export interface RecipeSourceLink {
  kind: RecipeSourceLinkKind;
  url: string;
  label: string;
}

export interface Recipe {
  id: string;
  title: string;
  description: string;
  heroImage: string | null;
  sourceType: SourceType;
  sourceURL: string | null;
  sourceName: string | null;
  sourceLinks?: RecipeSourceLink[];
  author: string | null;
  servings: number | null;
  prepTime: number | null;
  cookTime: number | null;
  totalTime: number | null;
  cuisine: string | null;
  categories: string[];
  tags: string[];
  ingredients: Ingredient[];
  instructions: Instruction[];
  rating: number | null;
  favorite: boolean;
  notes: string;
  attachments: Attachment[];
  dateAdded: string;
  dateModified: string;
  lastCooked: string | null;
  timesCooked: number;
  revision: number;
  deletedAt: string | null;
}

export type RecipeDraft = Omit<
  Recipe,
  'dateAdded' | 'dateModified' | 'lastCooked' | 'timesCooked' | 'revision' | 'deletedAt'
>;

export interface MealPlanEntry {
  id: string;
  date: string;
  mealType: MealType;
  recipeId: string;
  servings: number | null;
  revision: number;
  dateModified: string;
}

export interface RecipeContribution {
  recipeId: string;
  recipeTitle: string;
  ingredientId: string;
  rawText: string;
  quantity: Rational | null;
  unit: string | null;
}

export interface GroceryItem {
  id: string;
  ingredientName: string;
  normalizedIngredient: string;
  quantity: Rational | null;
  unit: string | null;
  groceryCategory: GroceryCategory;
  checked: boolean;
  manual: boolean;
  recipeContributions: RecipeContribution[];
  revision: number;
  dateModified: string;
  purchasedAt?: string | null;
}

export interface HouseholdPreferences {
  pantryStaples: string[];
  sectionOrder: GroceryCategory[];
  excludePantryStaples: boolean;
  skylightDeviceEmail?: string | null;
}

export interface BootstrapData {
  recipes: Recipe[];
  mealPlan: MealPlanEntry[];
  groceryItems: GroceryItem[];
  preferences: HouseholdPreferences;
  user: { displayName: string; email: string };
  syncedAt: string;
}

export interface ImportResult {
  draft: RecipeDraft;
  warnings: string[];
  provider: 'schema-org' | 'text-parser' | 'manual-photo' | 'instagram-caption' | 'linked-recipe' | 'public-reader';
  sourcesChecked?: RecipeSourceLink[];
  completedAt?: string;
}

'use client';

import {
  BookOpen, CalendarDays, ChefHat, Cloud, Home, Menu, Plus, Search,
  Settings, ShoppingBasket, WifiOff, X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { addRational, aggregateRecipes, draftToRecipe, makeId, parseIngredientLine } from '../../lib/domain';
import { mergeGroceryItems, replaceGeneratedItems } from '../../lib/grocery-merge';
import { readSkylightEmailApp, saveSkylightEmailApp, type StoredGitHubConnection } from '../../lib/client-cache';
import { parseBackupFile } from '../../lib/github-sync';
import type { ImportRecipeUrl } from '../../lib/github-import-queue';
import type { RecommendedMeal } from '../../lib/meal-week-optimizer';
import type { GitHubConnectInput, SyncPresentation } from '../../lib/sync-types';
import { MEAL_TYPES } from '../../lib/types';
import type {
  MealType,
  BootstrapData, GroceryCategory, GroceryItem, HouseholdPreferences,
  MealPlanEntry, Recipe, RecipeDraft, SkylightEmailApp,
} from '../../lib/types';
import { AddRecipeSheet } from './AddRecipeSheet';
import { CookingMode } from './CookingMode';
import { GroceryView } from './GroceryView';
import { HomeView } from './HomeView';
import { MealPlannerView } from './MealPlannerView';
import { RecipeDetail } from './RecipeDetail';
import { RecipesView } from './RecipesView';
import { SettingsSheet } from './SettingsSheet';

type View = 'home' | 'recipes' | 'plan' | 'grocery';
type ToastState = { message: string; actionLabel?: string; action?: () => void } | null;
type AddMode = 'choose' | 'link' | 'paste' | 'manual';
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const NAV_ITEMS: Array<{ id: View; label: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'recipes', label: 'Recipes', icon: BookOpen },
  { id: 'plan', label: 'Meal plan', icon: CalendarDays },
  { id: 'grocery', label: 'Groceries', icon: ShoppingBasket },
];

function dateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function currentWeekEntries(entries: MealPlanEntry[]): MealPlanEntry[] {
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const startKey = dateKey(start);
  const endKey = dateKey(addDays(start, 6));
  return entries.filter((entry) => entry.date >= startKey && entry.date <= endKey);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function greetingFor(date: Date, displayName: string): string {
  const hour = date.getHours();
  const base = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = displayName.trim();
  const hasRealName = name && !name.includes('@') && !/kitchen|household|home$/i.test(name);
  return hasRealName ? `${base}, ${name.split(/\s+/)[0]}` : base;
}

// A link handed to Savor by the system share sheet (Android) or a shortcut
// may arrive in `url` or buried in `text`; the first http(s) link wins.
function sharedRecipeUrl(params: URLSearchParams): string | null {
  for (const key of ['url', 'text', 'title']) {
    const value = params.get(key);
    const match = value?.match(/https?:\/\/[^\s<>"'’”)\]]+/i);
    if (match) return match[0].replace(/[.,;:!?]+$/, '');
  }
  return null;
}

export function SavorApp({
  data, setData, connection, hasGitHubToken, sync, startInSettings,
  onConnectGitHub, onDisconnectGitHub, onSyncNow, onImportRecipeUrl,
}: {
  data: BootstrapData;
  setData: Dispatch<SetStateAction<BootstrapData>>;
  connection: StoredGitHubConnection | null;
  hasGitHubToken: boolean;
  sync: SyncPresentation;
  startInSettings: boolean;
  onConnectGitHub: (input: GitHubConnectInput) => Promise<void>;
  onDisconnectGitHub: () => Promise<void>;
  onSyncNow: () => Promise<void>;
  onImportRecipeUrl: ImportRecipeUrl;
}) {
  const [view, setView] = useState<View>('home');
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [cookingRecipe, setCookingRecipe] = useState<Recipe | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(startInSettings);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recipeFilter, setRecipeFilter] = useState<'all' | 'favorites' | 'quick' | 'recent'>('all');
  const [online, setOnline] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [skylightEmailApp, setSkylightEmailApp] = useState<SkylightEmailApp>('gmail');
  const [sharedUrl, setSharedUrl] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<AddMode>('choose');

  useEffect(() => {
    if (startInSettings) setSettingsOpen(true);
  }, [startInSettings]);

  function openAdd(mode: AddMode = 'choose') {
    setEditingRecipe(null);
    setAddMode(mode);
    setAddOpen(true);
  }

  function closeAdd() {
    setAddOpen(false);
    setEditingRecipe(null);
    setSharedUrl(null);
    setAddMode('choose');
  }

  // Each tab is its own page; carrying the previous tab's scroll offset over
  // leaves the new one opened halfway down.
  const lockedScrollRef = useRef(0);
  useEffect(() => {
    lockedScrollRef.current = 0;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [view]);

  // Overlays take part in browser history so the iPhone edge swipe (and the
  // Android back button) closes the top layer instead of leaving Savor.
  const layerDepth = (selectedRecipe ? 1 : 0) + (cookingRecipe ? 1 : 0) + (addOpen ? 1 : 0) + (settingsOpen ? 1 : 0);
  const historyDepthRef = useRef(0);
  const suppressPopRef = useRef(0);
  // Closers in stacking order: cooking mode paints over everything, Settings
  // can open over the add sheet, and the recipe detail sits underneath.
  const closeLayersRef = useRef<(count: number) => void>(() => undefined);
  closeLayersRef.current = (count) => {
    const closers = [
      cookingRecipe ? () => setCookingRecipe(null) : null,
      settingsOpen ? () => setSettingsOpen(false) : null,
      addOpen ? closeAdd : null,
      selectedRecipe ? () => setSelectedRecipe(null) : null,
    ].filter((closer): closer is () => void => Boolean(closer));
    closers.slice(0, count).forEach((closer) => closer());
  };
  useEffect(() => {
    const current = historyDepthRef.current;
    if (layerDepth > current) {
      for (let depth = current + 1; depth <= layerDepth; depth += 1) window.history.pushState({ savorLayer: depth }, '');
      historyDepthRef.current = layerDepth;
    } else if (layerDepth < current) {
      historyDepthRef.current = layerDepth;
      const state = window.history.state as { savorLayer?: number } | null;
      if (state?.savorLayer && state.savorLayer > layerDepth) {
        suppressPopRef.current += 1;
        window.history.go(layerDepth - state.savorLayer);
      }
    }
  }, [layerDepth]);
  useEffect(() => {
    const onPop = () => {
      if (suppressPopRef.current > 0) {
        suppressPopRef.current -= 1;
        return;
      }
      const state = window.history.state as { savorLayer?: number } | null;
      const depth = state?.savorLayer ?? 0;
      if (depth < historyDepthRef.current) {
        const toClose = historyDepthRef.current - depth;
        historyDepthRef.current = depth;
        closeLayersRef.current(toClose);
      } else if (depth > historyDepthRef.current) {
        // Forward into a layer entry that is no longer open: step back out of it.
        suppressPopRef.current += 1;
        window.history.go(historyDepthRef.current - depth);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // iOS Safari ignores overflow:hidden on the body behind a fixed layer, so the
  // page is pinned in place instead and put back where it was on close.
  useEffect(() => {
    const overlayOpen = Boolean(addOpen || settingsOpen || selectedRecipe || cookingRecipe);
    if (!overlayOpen && !mobileMenuOpen) return undefined;
    const scrollY = window.scrollY;
    lockedScrollRef.current = scrollY;
    const { style } = document.body;
    const previous = { position: style.position, top: style.top, width: style.width, overflow: style.overflow };
    style.position = 'fixed';
    style.top = `-${scrollY}px`;
    style.width = '100%';
    style.overflow = 'hidden';
    // The page underneath is also made inert, so a stray tap or a screen
    // reader cannot reach it while a layer is open.
    const background = [...document.querySelectorAll<HTMLElement>(overlayOpen ? '.app-main, .app-sidebar, .mobile-tabbar' : '.app-main, .mobile-tabbar')];
    background.forEach((element) => element.setAttribute('inert', ''));
    return () => {
      background.forEach((element) => element.removeAttribute('inert'));
      style.position = previous.position;
      style.top = previous.top;
      style.width = previous.width;
      style.overflow = previous.overflow;
      // If the view changed while the layer was open, the offset belongs to a
      // page that is no longer shown; start the new one at the top instead.
      window.scrollTo({ top: lockedScrollRef.current, left: 0, behavior: 'auto' });
    };
  }, [addOpen, cookingRecipe, mobileMenuOpen, selectedRecipe, settingsOpen]);

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    window.setTimeout(() => setToast((current) => current === next ? null : current), 4_800);
  }, []);

  useEffect(() => {
    let active = true;
    readSkylightEmailApp().then((value) => {
      if (active) setSkylightEmailApp(value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const changeSkylightEmailApp = useCallback((value: SkylightEmailApp) => {
    setSkylightEmailApp(value);
    saveSkylightEmailApp(value).catch(() => showToast({ message: 'Savor could not remember that email app on this device.' }));
  }, [showToast]);

  useEffect(() => {
    const initialSync = window.setTimeout(() => {
      setOnline(navigator.onLine);
      const params = new URLSearchParams(window.location.search);
      const requestedView = params.get('view');
      if (requestedView === 'home' || requestedView === 'recipes' || requestedView === 'plan' || requestedView === 'grocery') {
        setView(requestedView);
      }
      const shared = sharedRecipeUrl(params);
      if (shared) {
        setSharedUrl(shared);
        setEditingRecipe(null);
        setAddMode('link');
        setAddOpen(true);
      } else if (params.get('capture') === '1') {
        setAddOpen(true);
      }
      if (params.has('view') || params.has('capture') || shared || params.has('url') || params.has('text') || params.has('title')) {
        // Keep whatever layer state is already on this entry; only the query string goes.
        window.history.replaceState(window.history.state, '', window.location.pathname);
      }
    }, 0);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeinstallprompt', handleInstall);
    let active = true;
    let releaseWorker: (() => void) | undefined;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).then((registration) => {
        if (!active) return;
        const announce = () => showToast({
          message: 'A new version of Savor is ready.',
          actionLabel: 'Update now',
          action: () => window.location.reload(),
        });
        const watchInstall = () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // Reaching "installed" while a worker already controls the page means
            // this is an update rather than the very first install.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) announce();
          });
        };
        registration.addEventListener('updatefound', watchInstall);
        if (registration.waiting && navigator.serviceWorker.controller) announce();
        // Installed iPhone apps stay suspended for days without ever reloading,
        // so look for a newer build every time Savor comes back to the front.
        const checkForUpdate = () => {
          if (document.visibilityState === 'visible') registration.update().catch(() => undefined);
        };
        document.addEventListener('visibilitychange', checkForUpdate);
        checkForUpdate();
        releaseWorker = () => {
          registration.removeEventListener('updatefound', watchInstall);
          document.removeEventListener('visibilitychange', checkForUpdate);
        };
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      window.clearTimeout(initialSync);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleInstall);
      releaseWorker?.();
    };
  }, [showToast]);

  async function saveRecipe(draft: RecipeDraft) {
    const existing = data.recipes.find((recipe) => recipe.id === draft.id);
    const recipe = existing
      ? { ...existing, ...draft, dateModified: new Date().toISOString(), revision: existing.revision + 1 }
      : draftToRecipe(draft);
    setData((current) => ({ ...current, recipes: [recipe, ...current.recipes.filter((item) => item.id !== recipe.id)] }));
    closeAdd();
    setSelectedRecipe(recipe);
    showToast({ message: existing ? 'Recipe updated.' : 'Recipe saved to your cookbook.' });
  }

  async function toggleFavorite(recipe: Recipe) {
    const favorite = !recipe.favorite;
    const optimistic = { ...recipe, favorite, dateModified: new Date().toISOString(), revision: recipe.revision + 1 };
    setData((current) => ({ ...current, recipes: current.recipes.map((item) => item.id === recipe.id ? optimistic : item) }));
    setSelectedRecipe((current) => current?.id === recipe.id ? optimistic : current);
  }

  async function deleteRecipe(recipe: Recipe) {
    setSelectedRecipe(null);
    // Planned meals for a deleted recipe would otherwise linger as orphans that
    // the week view cannot show and the optimizer flags forever.
    const orphanedMeals = data.mealPlan.filter((entry) => entry.recipeId === recipe.id);
    setData((current) => ({
      ...current,
      recipes: current.recipes.filter((item) => item.id !== recipe.id),
      mealPlan: current.mealPlan.filter((entry) => entry.recipeId !== recipe.id),
    }));
    const restore = async () => {
      const restoredAt = new Date().toISOString();
      const restored = { ...recipe, dateModified: restoredAt, revision: recipe.revision + 1 };
      setData((current) => ({
        ...current,
        recipes: [restored, ...current.recipes],
        mealPlan: [...current.mealPlan, ...orphanedMeals.map((entry) => ({ ...entry, dateModified: restoredAt, revision: entry.revision + 1 }))]
          .sort((a, b) => a.date.localeCompare(b.date) || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType)),
      }));
      showToast({ message: 'Recipe restored.' });
    };
    showToast({ message: orphanedMeals.length ? 'Recipe and its planned meals deleted.' : 'Recipe deleted.', actionLabel: 'Undo', action: restore });
  }

  // Cooking mode layers over the recipe rather than replacing it, so leaving
  // the kitchen returns to the recipe instead of whatever tab was underneath.
  function startCooking(recipe: Recipe) {
    if (!recipe.instructions.length) {
      showToast({
        message: 'This recipe has no steps yet.',
        actionLabel: 'Add steps',
        action: () => { setEditingRecipe(recipe); setSelectedRecipe(null); setAddMode('choose'); setAddOpen(true); },
      });
      return;
    }
    setSelectedRecipe(recipe);
    setCookingRecipe(recipe);
  }

  async function markCooked(recipe: Recipe) {
    const updated = {
      ...recipe,
      lastCooked: new Date().toISOString(),
      timesCooked: recipe.timesCooked + 1,
      dateModified: new Date().toISOString(),
      revision: recipe.revision + 1,
    };
    setData((current) => ({ ...current, recipes: current.recipes.map((item) => item.id === recipe.id ? updated : item) }));
    setCookingRecipe(null);
    showToast({ message: 'Meal remembered. Nice work.' });
  }

  async function duplicateRecipe(recipe: Recipe) {
    const now = new Date().toISOString();
    const copy: Recipe = {
      ...recipe, id: makeId('recipe'), title: `${recipe.title} — copy`, favorite: false, rating: null,
      dateAdded: now, dateModified: now, lastCooked: null, timesCooked: 0, revision: 1,
      ingredients: recipe.ingredients.map((item) => ({ ...item, id: makeId('ing') })),
      instructions: recipe.instructions.map((item) => ({ ...item, id: makeId('step') })),
    };
    setData((current) => ({ ...current, recipes: [copy, ...current.recipes] }));
    setSelectedRecipe(copy);
    showToast({ message: 'Recipe duplicated.' });
  }

  async function planRecipes(
    recipeIds: string[],
    startDate = dateKey(addDays(new Date(), 1)),
    mealType: MealType = 'dinner',
    servingsByRecipe: Record<string, number | null> = {},
  ) {
    const start = new Date(`${startDate}T12:00:00`);
    if (!DATE_KEY_PATTERN.test(startDate) || Number.isNaN(start.getTime())) {
      showToast({ message: 'Pick a date first.' });
      return;
    }
    const entries = recipeIds.map((recipeId, index): MealPlanEntry => {
      const recipe = data.recipes.find((item) => item.id === recipeId);
      return {
        id: makeId('meal'), date: dateKey(addDays(start, index)), mealType,
        recipeId, servings: servingsByRecipe[recipeId] ?? recipe?.servings ?? 4, revision: 1, dateModified: new Date().toISOString(),
      };
    });
    setData((current) => ({
      ...current,
      mealPlan: [...current.mealPlan, ...entries].sort((a, b) => a.date.localeCompare(b.date)
        || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType)),
    }));
    showToast({ message: `${entries.length} ${entries.length === 1 ? 'meal' : 'meals'} added to the plan.` });
  }

  async function removeMeal(entry: MealPlanEntry) {
    setData((current) => ({ ...current, mealPlan: current.mealPlan.filter((item) => item.id !== entry.id) }));
    showToast({
      message: 'Meal removed from the plan.',
      actionLabel: 'Undo',
      action: () => setData((current) => ({
        ...current,
        mealPlan: [...current.mealPlan.filter((item) => item.id !== entry.id), { ...entry, dateModified: new Date().toISOString(), revision: entry.revision + 1 }]
          .sort((a, b) => a.date.localeCompare(b.date) || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType)),
      })),
    });
  }

  async function applyMealOptimization(schedule: readonly RecommendedMeal[]) {
    const recommendedDates = new Map(schedule.map((meal) => [meal.sourceEntryId, meal.date]));
    const movedCount = schedule.filter((meal) => meal.moved).length;
    const changedAt = new Date().toISOString();
    setData((current) => ({
      ...current,
      mealPlan: current.mealPlan.map((entry) => {
        const recommendedDate = recommendedDates.get(entry.id);
        if (!recommendedDate || recommendedDate === entry.date) return entry;
        return { ...entry, date: recommendedDate, revision: entry.revision + 1, dateModified: changedAt };
      }).sort((a, b) => a.date.localeCompare(b.date)
        || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType)),
    }));
    showToast({ message: `${movedCount} ${movedCount === 1 ? 'meal was' : 'meals were'} moved to fresher days.` });
  }

  const excludedStaples = () => (data.preferences.excludePantryStaples ? data.preferences.pantryStaples : []);

  // Rebuilds the generated part of the list from planned meals. Rows that
  // survive keep their id and checked state; manual rows are left alone.
  async function generateGroceries(mealEntries?: MealPlanEntry[]) {
    const plannedEntries = mealEntries ?? currentWeekEntries(data.mealPlan);
    const recipesById = new Map(data.recipes.map((recipe) => [recipe.id, recipe]));
    const occurrences = plannedEntries
      .filter((entry) => recipesById.has(entry.recipeId))
      .map((entry) => ({ recipeId: entry.recipeId, servings: entry.servings }));
    if (!occurrences.length) {
      showToast({ message: plannedEntries.length ? 'The recipes planned for this week no longer exist.' : 'Plan a meal first, or add a recipe’s ingredients from the cookbook.' });
      return;
    }
    const selectedRecipes = [...new Set(occurrences.map((occurrence) => occurrence.recipeId))]
      .map((id) => recipesById.get(id))
      .filter((recipe): recipe is Recipe => Boolean(recipe));
    const generated = aggregateRecipes(selectedRecipes, {}, excludedStaples(), occurrences);
    setData((current) => ({ ...current, groceryItems: replaceGeneratedItems(current.groceryItems, generated) }));
    setView('grocery');
    showToast({ message: `${generated.length} grocery ${generated.length === 1 ? 'item' : 'items'} from ${selectedRecipes.length} planned ${selectedRecipes.length === 1 ? 'recipe' : 'recipes'}.` });
  }

  // Adds one or more recipes' ingredients on top of whatever is already listed.
  // From inside a recipe the person stays on the recipe and gets a shortcut to
  // the list; from a multi-select the list opens directly.
  async function addRecipesToGroceries(recipeIds: string[], servingsByRecipe: Record<string, number | null> = {}, options: { openList?: boolean } = {}) {
    const selectedRecipes = data.recipes.filter((recipe) => recipeIds.includes(recipe.id));
    if (!selectedRecipes.length) {
      showToast({ message: 'Select at least one recipe first.' });
      return;
    }
    const generated = aggregateRecipes(selectedRecipes, servingsByRecipe, excludedStaples());
    setData((current) => ({ ...current, groceryItems: mergeGroceryItems(current.groceryItems, generated, new Date().toISOString(), { pin: true }) }));
    const message = selectedRecipes.length === 1
      ? `${selectedRecipes[0].title} added to the grocery list.`
      : `${selectedRecipes.length} recipes added to the grocery list.`;
    if (options.openList) {
      setView('grocery');
      showToast({ message });
      return;
    }
    showToast({
      message,
      actionLabel: 'View list',
      action: () => { setSelectedRecipe(null); setCookingRecipe(null); setView('grocery'); },
    });
  }

  async function addGroceryItem(rawText: string) {
    const ingredient = parseIngredientLine(rawText);
    const now = new Date().toISOString();
    setData((current) => {
      // Typing "2 lemons" when a typed lemons row already exists tops up that
      // row instead of adding a second one. Generated rows are left alone so
      // a refresh from the meal plan cannot swallow the typed amount.
      const existing = current.groceryItems.find((row) => row.manual
        && row.normalizedIngredient === ingredient.normalizedIngredient
        && !row.checked
        && (row.unit ?? null) === (ingredient.normalizedUnit ?? null));
      if (existing) {
        return {
          ...current,
          groceryItems: current.groceryItems.map((row) => row.id !== existing.id ? row : {
            ...row,
            quantity: row.quantity && ingredient.quantity ? addRational(row.quantity, ingredient.quantity) : row.quantity ?? ingredient.quantity,
            revision: row.revision + 1,
            dateModified: now,
          }),
        };
      }
      const item: GroceryItem = {
        id: makeId('grocery'), ingredientName: ingredient.ingredientName,
        normalizedIngredient: ingredient.normalizedIngredient, quantity: ingredient.quantity,
        unit: ingredient.normalizedUnit, groceryCategory: ingredient.groceryCategory,
        checked: false, purchasedAt: null, manual: true, recipeContributions: [], revision: 1,
        dateModified: now,
      };
      return { ...current, groceryItems: [...current.groceryItems, item] };
    });
  }

  async function toggleGroceryItem(item: GroceryItem) {
    const checked = !item.checked;
    const changedAt = new Date().toISOString();
    setData((current) => ({
      ...current,
      groceryItems: current.groceryItems.map((row) => row.id === item.id ? {
        ...row, checked, purchasedAt: checked ? changedAt : null,
        revision: row.revision + 1, dateModified: changedAt,
      } : row),
    }));
  }

  async function uncheckAllGroceries() {
    const changedAt = new Date().toISOString();
    setData((current) => ({
      ...current,
      groceryItems: current.groceryItems.map((row) => row.checked
        ? { ...row, checked: false, purchasedAt: null, revision: row.revision + 1, dateModified: changedAt }
        : row),
    }));
  }

  // A row that comes back through Undo needs a fresh timestamp, otherwise the
  // deletion tombstone recorded a moment ago outranks it at the next sync.
  function restoreRows<T extends { id: string; revision: number; dateModified: string }>(rows: T[], restored: T[]): T[] {
    const restoredAt = new Date().toISOString();
    const returning = new Set(restored.map((row) => row.id));
    return [...rows.filter((row) => !returning.has(row.id)), ...restored.map((row) => ({ ...row, revision: row.revision + 1, dateModified: restoredAt }))];
  }

  async function clearCheckedGroceries() {
    const removed = data.groceryItems.filter((item) => item.checked);
    if (!removed.length) return;
    setData((current) => ({ ...current, groceryItems: current.groceryItems.filter((row) => !row.checked) }));
    showToast({
      message: `${removed.length} checked ${removed.length === 1 ? 'item' : 'items'} cleared.`,
      actionLabel: 'Undo',
      action: () => setData((current) => ({ ...current, groceryItems: restoreRows(current.groceryItems, removed) })),
    });
  }

  async function addPantryStaple(item: GroceryItem) {
    const staple = item.normalizedIngredient.trim().toLowerCase();
    const wasExcluding = data.preferences.excludePantryStaples;
    setData((current) => ({
      ...current,
      preferences: {
        ...current.preferences,
        excludePantryStaples: true,
        pantryStaples: current.preferences.pantryStaples.includes(staple)
          ? current.preferences.pantryStaples
          : [...current.preferences.pantryStaples, staple],
      },
      groceryItems: current.groceryItems.filter((row) => row.id !== item.id),
    }));
    showToast({
      message: wasExcluding
        ? `${item.ingredientName} is now a pantry staple.`
        : `${item.ingredientName} is now a pantry staple, and staples are excluded from generated lists.`,
      actionLabel: 'Undo',
      action: () => setData((current) => ({
        ...current,
        preferences: {
          ...current.preferences,
          excludePantryStaples: wasExcluding,
          pantryStaples: current.preferences.pantryStaples.filter((entry) => entry !== staple),
        },
        groceryItems: restoreRows(current.groceryItems, [item]),
      })),
    });
  }

  async function updateGroceryCategory(item: GroceryItem, category: GroceryCategory) {
    setData((current) => ({
      ...current,
      groceryItems: current.groceryItems.map((row) => row.id === item.id ? {
        ...row, groceryCategory: category, revision: row.revision + 1, dateModified: new Date().toISOString(),
      } : row),
    }));
  }

  async function deleteGrocery(item: GroceryItem) {
    setData((current) => ({ ...current, groceryItems: current.groceryItems.filter((row) => row.id !== item.id) }));
  }

  async function savePreferences(preferences: HouseholdPreferences) {
    setData((current) => ({ ...current, preferences }));
    setSettingsOpen(false);
    showToast({ message: 'Household preferences saved.' });
  }

  async function exportBackup() {
    try {
      const { recipes, mealPlan, groceryItems, preferences, syncedAt } = data;
      const payload = JSON.stringify({ format: 'savor-household-backup', version: 1, exportedAt: new Date().toISOString(), recipes, mealPlan, groceryItems, preferences, syncedAt }, null, 2);
      const filename = `savor-backup-${dateKey(new Date())}.json`;
      const file = new File([payload], filename, { type: 'application/json' });
      // An installed iPhone app has no Downloads folder to speak of; the share
      // sheet lets the household save to Files, AirDrop it, or mail it.
      const sharing = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (typeof sharing.share === 'function' && sharing.canShare?.({ files: [file] })) {
        try {
          await sharing.share({ files: [file], title: 'Savor backup' });
          showToast({ message: 'Backup ready.' });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          // Fall through to a plain download.
        }
      }
      const href = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
      showToast({ message: 'Backup downloaded.' });
    } catch {
      showToast({ message: 'Backup could not be created.' });
    }
  }

  async function importBackup(file: File) {
    if (file.size > 25_000_000) throw new Error('Backups must be smaller than 25 MB.');
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); }
    catch { throw new Error('That backup is not valid JSON.'); }
    const imported = parseBackupFile(parsed, data.user);
    const restoredAt = new Date().toISOString();
    const mergeRows = <T extends { id: string; dateModified?: string; revision?: number }>(current: T[], incoming: T[]) => {
      const rows = new Map(current.map((row) => [row.id, row]));
      for (const row of incoming) {
        const existing = rows.get(row.id);
        if (!existing) {
          // A row the household deleted earlier may still have a tombstone; a
          // fresh timestamp makes the deliberate re-import win over it.
          rows.set(row.id, { ...row, dateModified: restoredAt, revision: (row.revision ?? 0) + 1 });
        } else if ((row.dateModified ?? '') > (existing.dateModified ?? '')) {
          rows.set(row.id, row);
        }
      }
      return [...rows.values()];
    };
    const exportedAt = isObject(parsed) && typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '';
    setData((current) => ({
      ...current,
      recipes: mergeRows(current.recipes, imported.recipes),
      mealPlan: mergeRows(current.mealPlan, imported.mealPlan).sort((a, b) => a.date.localeCompare(b.date)),
      groceryItems: mergeRows(current.groceryItems, imported.groceryItems),
      // Preferences merge rather than replace: staples are unioned, and the
      // store route and Skylight address stay unless the backup is newer.
      preferences: {
        ...current.preferences,
        pantryStaples: [...new Set([...current.preferences.pantryStaples, ...imported.preferences.pantryStaples])],
        ...(exportedAt && exportedAt > data.syncedAt ? {
          sectionOrder: imported.preferences.sectionOrder,
          excludePantryStaples: imported.preferences.excludePantryStaples,
          skylightDeviceEmail: imported.preferences.skylightDeviceEmail ?? current.preferences.skylightDeviceEmail,
        } : {}),
      },
    }));
    showToast({ message: 'Backup merged. Nothing was deleted, and pantry staples were combined.' });
  }

  async function installApp() {
    if (!installPrompt) return;
    const promptEvent = installPrompt as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    await promptEvent.prompt();
    await promptEvent.userChoice;
    setInstallPrompt(null);
  }

  function openQuickPick(label: string) {
    const preset = label === 'Under 30 minutes' ? 'quick'
      : label === 'Favorites' ? 'favorites'
        : label === 'Recently added' ? 'recent' : 'all';
    setRecipeFilter(preset);
    setQuery(preset === 'all' ? label : '');
    setView('recipes');
  }

  const pageTitle = { home: 'Home', recipes: 'Recipes', plan: 'Meal plan', grocery: 'Grocery list' }[view];
  const recipeCount = data.recipes.length;
  const leftToBuy = data.groceryItems.filter((item) => !item.checked).length;
  const subtitle = {
    home: 'What are we eating?',
    recipes: `${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'} in your household cookbook`,
    plan: 'A calm view of the week ahead',
    grocery: `${leftToBuy} ${leftToBuy === 1 ? 'item' : 'items'} left to pick up`,
  }[view];
  const greeting = greetingFor(new Date(), data.user.displayName);

  const selectedFresh = selectedRecipe ? data.recipes.find((recipe) => recipe.id === selectedRecipe.id) ?? selectedRecipe : null;
  const cookingFresh = cookingRecipe ? data.recipes.find((recipe) => recipe.id === cookingRecipe.id) ?? cookingRecipe : null;
  const activeCount = data.groceryItems.filter((item) => !item.checked).length;
  const syncLabel = online ? sync.label : 'Offline';

  return (
    <div className="savor-shell">
      <aside className={mobileMenuOpen ? 'app-sidebar app-sidebar-open' : 'app-sidebar'} aria-label="Primary navigation">
        <div className="sidebar-head">
          <button className="brand-button" type="button" onClick={() => { setView('home'); setMobileMenuOpen(false); }}>
            <span className="brand-seal" aria-hidden="true"><ChefHat size={20} /></span>
            <span className="brand-word">Savor</span>
          </button>
          <button aria-label="Close menu" className="sidebar-close icon-button" type="button" onClick={() => setMobileMenuOpen(false)}><X size={20} /></button>
        </div>
        <button className="primary-add" type="button" onClick={() => { openAdd(); setMobileMenuOpen(false); }}><Plus size={18} /> Add recipe</button>
        <nav className="desktop-nav">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button className={view === item.id ? 'desktop-nav-item active' : 'desktop-nav-item'} key={item.id} type="button" onClick={() => { setView(item.id); setMobileMenuOpen(false); }}>
                <Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>
                {item.id === 'grocery' && activeCount > 0 ? <span className="nav-count">{activeCount}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-household">
          <button className="household-button" type="button" onClick={() => setSettingsOpen(true)}>
            <span className="household-avatar">{data.user.displayName.slice(0, 1).toUpperCase()}</span>
            <span><strong>Our kitchen</strong><small>{syncLabel}</small></span>
            <Settings size={16} aria-hidden="true" />
          </button>
        </div>
      </aside>

      {mobileMenuOpen ? <button className="sidebar-scrim" aria-label="Close menu" type="button" onClick={() => setMobileMenuOpen(false)} /> : null}

      <main className="app-main">
        <header className="app-header">
          <div className="mobile-brand-row">
            <button className="icon-button menu-button" aria-label="Open menu" type="button" onClick={() => setMobileMenuOpen(true)}><Menu size={21} /></button>
            <button className="mobile-brand" type="button" onClick={() => setView('home')}><ChefHat size={19} /><span>Savor</span></button>
            <button className="icon-button settings-button" aria-label={`Open settings. ${syncLabel}`} type="button" onClick={() => setSettingsOpen(true)}>
              <Settings size={19} />
              {!online || sync.phase === 'error' || sync.phase === 'needs-token' ? <span className="sync-dot" aria-hidden="true" /> : null}
            </button>
          </div>
          <div className="page-heading">
            <div>
              {view === 'home' ? <p className="eyebrow">{greeting}</p> : null}
              <h1>{pageTitle}</h1>
              <p>{subtitle}</p>
            </div>
            <div className="header-tools">
              {view === 'recipes' ? (
                <label className="global-search">
                  <Search size={17} aria-hidden="true" />
                  <span className="sr-only">Search recipes</span>
                  <input type="search" placeholder="Search recipes or ingredients" value={query} onChange={(event) => setQuery(event.target.value)} />
                </label>
              ) : null}
              <span className={online && sync.phase !== 'error' && sync.phase !== 'needs-token' ? 'sync-pill' : 'sync-pill offline'}>{online ? <Cloud size={14} /> : <WifiOff size={14} />}{syncLabel}</span>
              <button className="header-add" type="button" onClick={() => openAdd()}><Plus size={17} />Add recipe</button>
            </div>
          </div>
        </header>

        <div className="view-wrap">
          {view === 'home' ? (
            <HomeView data={data} onOpenRecipe={setSelectedRecipe} onCook={startCooking} onNavigate={setView} onGenerateGroceries={() => generateGroceries()} onAddRecipe={openAdd} onQuickPick={openQuickPick} />
          ) : null}
          {view === 'recipes' ? (
            <RecipesView recipes={data.recipes} query={query} onQueryChange={setQuery} filter={recipeFilter} onFilterChange={setRecipeFilter} onOpenRecipe={setSelectedRecipe} onToggleFavorite={toggleFavorite} onAddRecipe={() => openAdd()} onPlanRecipes={planRecipes} onAddToGroceries={(ids) => addRecipesToGroceries(ids, {}, { openList: true })} />
          ) : null}
          {view === 'plan' ? (
            <MealPlannerView recipes={data.recipes} entries={data.mealPlan} groceryItems={data.groceryItems} skylightEmail={data.preferences.skylightDeviceEmail ?? null} skylightEmailApp={skylightEmailApp} onChangeSkylightEmailApp={changeSkylightEmailApp} onOpenSettings={() => setSettingsOpen(true)} onPlanRecipes={planRecipes} onRemoveMeal={removeMeal} onOpenRecipe={setSelectedRecipe} onGenerateGroceries={(entries) => generateGroceries(entries)} onApplyOptimization={applyMealOptimization} />
          ) : null}
          {view === 'grocery' ? (
            <GroceryView items={data.groceryItems} preferences={data.preferences} onToggle={toggleGroceryItem} onAdd={addGroceryItem} onDelete={deleteGrocery} onChangeCategory={updateGroceryCategory} onGenerate={() => generateGroceries()} onClearChecked={clearCheckedGroceries} onUncheckAll={uncheckAllGroceries} onAddPantryStaple={addPantryStaple} />
          ) : null}
        </div>
      </main>

      <nav className="mobile-tabbar" aria-label="Primary navigation">
        {NAV_ITEMS.slice(0, 2).map((item) => {
          const Icon = item.icon;
          return <button className={view === item.id ? 'mobile-tab active' : 'mobile-tab'} key={item.id} type="button" onClick={() => setView(item.id)}><Icon size={19} /><span>{item.label}</span></button>;
        })}
        <button className="mobile-add-button" aria-label="Add recipe" type="button" onClick={() => openAdd()}><Plus size={22} /></button>
        {NAV_ITEMS.slice(2).map((item) => {
          const Icon = item.icon;
          return <button className={view === item.id ? 'mobile-tab active' : 'mobile-tab'} key={item.id} type="button" onClick={() => setView(item.id)}><Icon size={19} /><span>{item.id === 'grocery' ? 'List' : 'Plan'}</span>{item.id === 'grocery' && activeCount ? <b>{activeCount}</b> : null}</button>;
        })}
      </nav>

      {selectedFresh ? (
        <RecipeDetail
          key={`detail-${selectedFresh.id}`}
          recipe={selectedFresh}
          onClose={() => setSelectedRecipe(null)}
          onCook={() => startCooking(selectedFresh)}
          onFavorite={() => toggleFavorite(selectedFresh)}
          onPlan={(date, servings, mealType) => planRecipes([selectedFresh.id], date, mealType, { [selectedFresh.id]: servings })}
          onGroceries={(servings) => addRecipesToGroceries([selectedFresh.id], { [selectedFresh.id]: servings })}
          onEdit={() => { setEditingRecipe(selectedFresh); setSelectedRecipe(null); setAddMode('choose'); setAddOpen(true); }}
          onDuplicate={() => duplicateRecipe(selectedFresh)}
          onDelete={() => deleteRecipe(selectedFresh)}
          showToast={showToast}
        />
      ) : null}

      {addOpen ? (
        <AddRecipeSheet
          key={editingRecipe ? `edit-${editingRecipe.id}` : 'new'}
          initialRecipe={editingRecipe}
          initialUrl={editingRecipe ? null : sharedUrl}
          initialMode={editingRecipe ? 'choose' : addMode}
          canImportLinks={Boolean(connection && hasGitHubToken)}
          onClose={closeAdd}
          onSave={saveRecipe}
          onImportRecipeUrl={onImportRecipeUrl}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : null}

      {cookingFresh ? <CookingMode key={`cooking-${cookingFresh.id}`} recipe={cookingFresh} onClose={() => setCookingRecipe(null)} onFinish={() => markCooked(cookingFresh)} showToast={showToast} /> : null}

      {settingsOpen ? (
        <SettingsSheet
          preferences={data.preferences}
          skylightEmailApp={skylightEmailApp}
          connection={connection}
          hasGitHubToken={hasGitHubToken}
          sync={sync}
          installAvailable={Boolean(installPrompt)}
          onInstall={installApp}
          onChangeSkylightEmailApp={changeSkylightEmailApp}
          onSave={savePreferences}
          onExport={exportBackup}
          onImport={importBackup}
          onConnectGitHub={onConnectGitHub}
          onDisconnectGitHub={onDisconnectGitHub}
          onSyncNow={onSyncNow}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          <span>{toast.message}</span>
          {toast.action ? <button type="button" onClick={() => { toast.action?.(); setToast(null); }}>{toast.actionLabel}</button> : null}
          <button className="toast-close" aria-label="Dismiss" type="button" onClick={() => setToast(null)}><X size={15} /></button>
        </div>
      ) : null}
    </div>
  );
}

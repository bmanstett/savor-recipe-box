'use client';

import {
  BookOpen, CalendarDays, ChefHat, Cloud, Home, Menu, Plus, Search,
  Settings, ShoppingBasket, WifiOff, X,
} from 'lucide-react';
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { aggregateRecipes, draftToRecipe, makeId, parseIngredientLine } from '../../lib/domain';
import { readSkylightEmailApp, saveSkylightEmailApp, type StoredGitHubConnection } from '../../lib/client-cache';
import { parseBackupFile } from '../../lib/github-sync';
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

export function SavorApp({
  data, setData, connection, sync, startInSettings,
  onConnectGitHub, onDisconnectGitHub, onSyncNow,
}: {
  data: BootstrapData;
  setData: Dispatch<SetStateAction<BootstrapData>>;
  connection: StoredGitHubConnection | null;
  sync: SyncPresentation;
  startInSettings: boolean;
  onConnectGitHub: (input: GitHubConnectInput) => Promise<void>;
  onDisconnectGitHub: () => Promise<void>;
  onSyncNow: () => Promise<void>;
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
      if (params.get('capture') === '1') setAddOpen(true);
      if (params.has('view') || params.has('capture')) window.history.replaceState({}, '', window.location.pathname);
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
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => undefined);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleInstall);
    };
  }, []);

  async function saveRecipe(draft: RecipeDraft) {
    const existing = data.recipes.find((recipe) => recipe.id === draft.id);
    const recipe = existing
      ? { ...existing, ...draft, dateModified: new Date().toISOString(), revision: existing.revision + 1 }
      : draftToRecipe(draft);
    setData((current) => ({ ...current, recipes: [recipe, ...current.recipes.filter((item) => item.id !== recipe.id)] }));
    setAddOpen(false);
    setEditingRecipe(null);
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
    setData((current) => ({ ...current, recipes: current.recipes.filter((item) => item.id !== recipe.id) }));
    const restore = async () => {
      const restored = { ...recipe, dateModified: new Date().toISOString(), revision: recipe.revision + 1 };
      setData((current) => ({ ...current, recipes: [restored, ...current.recipes] }));
      showToast({ message: 'Recipe restored.' });
    };
    showToast({ message: 'Recipe deleted.', actionLabel: 'Undo', action: restore });
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
      ...recipe, id: makeId('recipe'), title: `${recipe.title} — copy`, sourceType: 'manual',
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
    showToast({ message: 'Meal removed from the plan.' });
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

  async function generateGroceries(recipeIds?: string[], mealEntries?: MealPlanEntry[], selectedServings: Record<string, number | null> = {}) {
    const plannedEntries = recipeIds?.length ? [] : (mealEntries ?? currentWeekEntries(data.mealPlan));
    const selectedIds = recipeIds?.length ? recipeIds : [...new Set(plannedEntries.map((entry) => entry.recipeId))];
    if (!selectedIds.length) {
      showToast({ message: 'Plan a meal or select recipes first.' });
      return;
    }
    const selectedRecipes = data.recipes.filter((recipe) => selectedIds.includes(recipe.id));
    const servingsByRecipe = recipeIds?.length ? selectedServings : Object.fromEntries(plannedEntries.map((entry) => [entry.recipeId, entry.servings]));
    const occurrences = plannedEntries.map((entry) => ({ recipeId: entry.recipeId, servings: entry.servings }));
    const generated = aggregateRecipes(
      selectedRecipes,
      servingsByRecipe,
      data.preferences.excludePantryStaples ? data.preferences.pantryStaples : [],
      occurrences,
    );
    const manual = data.groceryItems.filter((item) => item.manual);
    const purchased = new Map(data.groceryItems.map((item) => [`${item.normalizedIngredient}|${item.unit}`, {
      checked: item.checked,
      purchasedAt: item.purchasedAt ?? (item.checked ? item.dateModified : null),
    }]));
    const optimistic = generated.map((item) => {
      const previous = purchased.get(`${item.normalizedIngredient}|${item.unit}`);
      return { ...item, checked: previous?.checked ?? false, purchasedAt: previous?.purchasedAt ?? null };
    });
    setData((current) => ({ ...current, groceryItems: [...optimistic, ...manual] }));
    setView('grocery');
    showToast({ message: `${generated.length} grocery items organized by aisle.` });
  }

  async function addGroceryItem(rawText: string) {
    const ingredient = parseIngredientLine(rawText);
    const item: GroceryItem = {
      id: makeId('grocery'), ingredientName: ingredient.ingredientName,
      normalizedIngredient: ingredient.normalizedIngredient, quantity: ingredient.quantity,
      unit: ingredient.normalizedUnit, groceryCategory: ingredient.groceryCategory,
      checked: false, purchasedAt: null, manual: true, recipeContributions: [], revision: 1,
      dateModified: new Date().toISOString(),
    };
    setData((current) => ({ ...current, groceryItems: [...current.groceryItems, item] }));
  }

  async function toggleGroceryItem(item: GroceryItem) {
    const checked = !item.checked;
    const update = (value: boolean) => {
      const changedAt = new Date().toISOString();
      setData((current) => ({
        ...current,
        groceryItems: current.groceryItems.map((row) => row.id === item.id ? {
          ...row, checked: value, purchasedAt: value ? changedAt : null,
          revision: row.revision + 1, dateModified: changedAt,
        } : row),
      }));
    };
    update(checked);
    showToast(checked ? {
      message: `${item.ingredientName} checked off.`, actionLabel: 'Undo',
      action: () => update(false),
    } : { message: `${item.ingredientName} returned to the list.` });
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
      const blob = new Blob([
        JSON.stringify({ format: 'savor-household-backup', version: 1, exportedAt: new Date().toISOString(), ...data, user: undefined }, null, 2),
      ], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `savor-backup-${dateKey(new Date())}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
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
    const mergeRows = <T extends { id: string; dateModified?: string }>(current: T[], incoming: T[]) => {
      const rows = new Map(current.map((row) => [row.id, row]));
      for (const row of incoming) {
        const existing = rows.get(row.id);
        if (!existing || (row.dateModified ?? '') > (existing.dateModified ?? '')) rows.set(row.id, row);
      }
      return [...rows.values()];
    };
    setData((current) => ({
      ...current,
      recipes: mergeRows(current.recipes, imported.recipes),
      mealPlan: mergeRows(current.mealPlan, imported.mealPlan).sort((a, b) => a.date.localeCompare(b.date)),
      groceryItems: mergeRows(current.groceryItems, imported.groceryItems),
      preferences: imported.preferences,
    }));
    showToast({ message: 'Backup merged safely.' });
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
  const subtitle = {
    home: 'What are we eating?',
    recipes: `${data.recipes.length} recipes in your household cookbook`,
    plan: 'A calm view of the week ahead',
    grocery: `${data.groceryItems.filter((item) => !item.checked).length} items left to pick up`,
  }[view];
  const firstName = data.user.displayName.includes('@') ? 'there' : data.user.displayName.split(' ')[0];

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
        <button className="primary-add" type="button" onClick={() => { setEditingRecipe(null); setAddOpen(true); setMobileMenuOpen(false); }}><Plus size={18} /> Add recipe</button>
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
            <button className="icon-button" aria-label="Open settings" type="button" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
          </div>
          <div className="page-heading">
            <div>
              {view === 'home' ? <p className="eyebrow">Good evening, {firstName}</p> : null}
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
              <button className="header-add" type="button" onClick={() => { setEditingRecipe(null); setAddOpen(true); }}><Plus size={17} />Add recipe</button>
            </div>
          </div>
        </header>

        <div className="view-wrap">
          {view === 'home' ? (
            <HomeView data={data} onOpenRecipe={setSelectedRecipe} onCook={setCookingRecipe} onNavigate={setView} onGenerateGroceries={() => generateGroceries()} onAddRecipe={() => setAddOpen(true)} onQuickPick={openQuickPick} />
          ) : null}
          {view === 'recipes' ? (
            <RecipesView recipes={data.recipes} query={query} onQueryChange={setQuery} filter={recipeFilter} onFilterChange={setRecipeFilter} onOpenRecipe={setSelectedRecipe} onToggleFavorite={toggleFavorite} onAddRecipe={() => setAddOpen(true)} onPlanRecipes={planRecipes} onGenerateGroceries={generateGroceries} />
          ) : null}
          {view === 'plan' ? (
            <MealPlannerView recipes={data.recipes} entries={data.mealPlan} groceryItems={data.groceryItems} skylightEmail={data.preferences.skylightDeviceEmail ?? null} skylightEmailApp={skylightEmailApp} onChangeSkylightEmailApp={changeSkylightEmailApp} onOpenSettings={() => setSettingsOpen(true)} onPlanRecipes={planRecipes} onRemoveMeal={removeMeal} onOpenRecipe={setSelectedRecipe} onGenerateGroceries={(entries) => generateGroceries(undefined, entries)} onApplyOptimization={applyMealOptimization} />
          ) : null}
          {view === 'grocery' ? (
            <GroceryView items={data.groceryItems} preferences={data.preferences} onToggle={toggleGroceryItem} onAdd={addGroceryItem} onDelete={deleteGrocery} onChangeCategory={updateGroceryCategory} onGenerate={() => generateGroceries()} />
          ) : null}
        </div>
      </main>

      <nav className="mobile-tabbar" aria-label="Primary navigation">
        {NAV_ITEMS.slice(0, 2).map((item) => {
          const Icon = item.icon;
          return <button className={view === item.id ? 'mobile-tab active' : 'mobile-tab'} key={item.id} type="button" onClick={() => setView(item.id)}><Icon size={19} /><span>{item.label}</span></button>;
        })}
        <button className="mobile-add-button" aria-label="Add recipe" type="button" onClick={() => { setEditingRecipe(null); setAddOpen(true); }}><Plus size={22} /></button>
        {NAV_ITEMS.slice(2).map((item) => {
          const Icon = item.icon;
          return <button className={view === item.id ? 'mobile-tab active' : 'mobile-tab'} key={item.id} type="button" onClick={() => setView(item.id)}><Icon size={19} /><span>{item.id === 'grocery' ? 'List' : 'Plan'}</span>{item.id === 'grocery' && activeCount ? <b>{activeCount}</b> : null}</button>;
        })}
      </nav>

      {selectedFresh ? (
        <RecipeDetail
          recipe={selectedFresh}
          onClose={() => setSelectedRecipe(null)}
          onCook={() => { setCookingRecipe(selectedFresh); setSelectedRecipe(null); }}
          onFavorite={() => toggleFavorite(selectedFresh)}
          onPlan={(date, servings, mealType) => planRecipes([selectedFresh.id], date, mealType, { [selectedFresh.id]: servings })}
          onGroceries={(servings) => generateGroceries([selectedFresh.id], undefined, { [selectedFresh.id]: servings })}
          onEdit={() => { setEditingRecipe(selectedFresh); setSelectedRecipe(null); setAddOpen(true); }}
          onDuplicate={() => duplicateRecipe(selectedFresh)}
          onDelete={() => deleteRecipe(selectedFresh)}
          showToast={showToast}
        />
      ) : null}

      {addOpen ? (
        <AddRecipeSheet initialRecipe={editingRecipe} onClose={() => { setAddOpen(false); setEditingRecipe(null); }} onSave={saveRecipe} />
      ) : null}

      {cookingFresh ? <CookingMode recipe={cookingFresh} onClose={() => setCookingRecipe(null)} onFinish={() => markCooked(cookingFresh)} showToast={showToast} /> : null}

      {settingsOpen ? (
        <SettingsSheet
          preferences={data.preferences}
          skylightEmailApp={skylightEmailApp}
          connection={connection}
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

'use client';

import {
  BookOpen, CalendarDays, ChefHat, Cloud, Home, Menu, Plus, Search,
  Settings, ShoppingBasket, WifiOff, X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { aggregateRecipes, draftToRecipe, makeId, parseIngredientLine } from '../../lib/domain';
import { cacheBootstrap, flushMutationQueue, queueMutation, readCachedBootstrap } from '../../lib/client-cache';
import type {
  BootstrapData, GroceryCategory, GroceryItem, HouseholdPreferences,
  MealPlanEntry, Recipe, RecipeDraft,
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

class ApiResponseError extends Error {}

export function SavorApp({ initialData }: { initialData: BootstrapData }) {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>('home');
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [cookingRecipe, setCookingRecipe] = useState<Recipe | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recipeFilter, setRecipeFilter] = useState<'all' | 'favorites' | 'quick' | 'recent'>('all');
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);

  const showToast = useCallback((next: ToastState) => {
    setToast(next);
    window.setTimeout(() => setToast((current) => current === next ? null : current), 4_800);
  }, []);

  useEffect(() => {
    if (navigator.onLine) cacheBootstrap(data).catch(() => undefined);
  }, [data]);

  const reload = useCallback(async () => {
    if (!navigator.onLine) return;
    setSyncing(true);
    try {
      const response = await fetch('/api/bootstrap', { cache: 'no-store' });
      if (response.ok) setData(await response.json() as BootstrapData);
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    const initialSync = window.setTimeout(() => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) {
        readCachedBootstrap().then((cached) => { if (cached) setData(cached); }).catch(() => undefined);
      }
      const params = new URLSearchParams(window.location.search);
      const requestedView = params.get('view');
      if (requestedView === 'home' || requestedView === 'recipes' || requestedView === 'plan' || requestedView === 'grocery') {
        setView(requestedView);
      }
      if (params.get('capture') === '1') setAddOpen(true);
      if (params.has('view') || params.has('capture')) window.history.replaceState({}, '', '/');
    }, 0);
    const handleOnline = async () => {
      setOnline(true);
      setSyncing(true);
      try {
        const completed = await flushMutationQueue();
        if (completed) await reload();
      } finally {
        setSyncing(false);
      }
    };
    const handleOffline = async () => {
      setOnline(false);
      const cached = await readCachedBootstrap().catch(() => null);
      if (cached) setData(cached);
    };
    const handleInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeinstallprompt', handleInstall);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleInstall);
    };
  }, [reload]);

  async function mutate<T>(url: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown, queueable = true): Promise<T | null> {
    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok) throw new ApiResponseError(payload.error || 'That change could not be saved.');
      return payload;
    } catch (error) {
      if (queueable && (!(error instanceof ApiResponseError) || !navigator.onLine)) {
        await queueMutation({ url, method, body }).catch(() => undefined);
        setOnline(false);
        showToast({ message: 'Saved on this device. Savor will sync when you’re online.' });
        return null;
      }
      throw error;
    }
  }

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
    try {
      const saved = await mutate<Recipe>('/api/recipes', 'POST', recipe);
      if (saved) {
        setData((current) => ({ ...current, recipes: current.recipes.map((item) => item.id === saved.id ? saved : item) }));
        setSelectedRecipe((current) => current?.id === saved.id ? saved : current);
      }
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : 'Recipe could not be saved.' });
    }
  }

  async function toggleFavorite(recipe: Recipe) {
    const favorite = !recipe.favorite;
    const optimistic = { ...recipe, favorite };
    setData((current) => ({ ...current, recipes: current.recipes.map((item) => item.id === recipe.id ? optimistic : item) }));
    setSelectedRecipe((current) => current?.id === recipe.id ? optimistic : current);
    try {
      const saved = await mutate<Recipe>(`/api/recipes/${recipe.id}`, 'PATCH', { favorite });
      if (saved) setData((current) => ({ ...current, recipes: current.recipes.map((item) => item.id === saved.id ? saved : item) }));
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : 'Favorite could not be changed.' });
    }
  }

  async function deleteRecipe(recipe: Recipe) {
    setSelectedRecipe(null);
    setData((current) => ({ ...current, recipes: current.recipes.filter((item) => item.id !== recipe.id) }));
    const restore = async () => {
      setData((current) => ({ ...current, recipes: [recipe, ...current.recipes] }));
      await mutate(`/api/recipes/${recipe.id}`, 'PATCH', { deletedAt: null });
      showToast({ message: 'Recipe restored.' });
    };
    showToast({ message: 'Recipe deleted.', actionLabel: 'Undo', action: restore });
    await mutate(`/api/recipes/${recipe.id}`, 'DELETE');
  }

  async function markCooked(recipe: Recipe) {
    const updated = { ...recipe, lastCooked: new Date().toISOString(), timesCooked: recipe.timesCooked + 1 };
    setData((current) => ({ ...current, recipes: current.recipes.map((item) => item.id === recipe.id ? updated : item) }));
    setCookingRecipe(null);
    await mutate(`/api/recipes/${recipe.id}`, 'PATCH', { lastCooked: updated.lastCooked, timesCooked: updated.timesCooked });
    showToast({ message: 'Dinner remembered. Nice work.' });
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
    await mutate('/api/recipes', 'POST', copy);
    showToast({ message: 'Recipe duplicated.' });
  }

  async function planRecipes(recipeIds: string[], startDate = dateKey(addDays(new Date(), 1)), servingsByRecipe: Record<string, number | null> = {}) {
    const start = new Date(`${startDate}T12:00:00`);
    const entries = recipeIds.map((recipeId, index): MealPlanEntry => {
      const recipe = data.recipes.find((item) => item.id === recipeId);
      return {
        id: makeId('meal'), date: dateKey(addDays(start, index)), mealType: 'dinner',
        recipeId, servings: servingsByRecipe[recipeId] ?? recipe?.servings ?? 4, revision: 1, dateModified: new Date().toISOString(),
      };
    });
    setData((current) => ({ ...current, mealPlan: [...current.mealPlan, ...entries].sort((a, b) => a.date.localeCompare(b.date)) }));
    await Promise.all(entries.map((entry) => mutate('/api/meal-plan', 'POST', entry)));
    showToast({ message: `${entries.length} ${entries.length === 1 ? 'meal' : 'meals'} added to the plan.` });
  }

  async function removeMeal(entry: MealPlanEntry) {
    setData((current) => ({ ...current, mealPlan: current.mealPlan.filter((item) => item.id !== entry.id) }));
    await mutate(`/api/meal-plan/${entry.id}`, 'DELETE');
    showToast({ message: 'Meal removed from the plan.' });
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
    const checked = new Map(data.groceryItems.map((item) => [`${item.normalizedIngredient}|${item.unit}`, item.checked]));
    const optimistic = generated.map((item) => ({ ...item, checked: checked.get(`${item.normalizedIngredient}|${item.unit}`) ?? false }));
    setData((current) => ({ ...current, groceryItems: [...optimistic, ...manual] }));
    setView('grocery');
    try {
      const result = await mutate<{ items: GroceryItem[] }>('/api/grocery/generate', 'POST', { recipeIds: selectedIds, servingsByRecipe, occurrences });
      if (result) setData((current) => ({ ...current, groceryItems: result.items }));
      showToast({ message: `${generated.length} grocery items organized by aisle.` });
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : 'Grocery list could not be generated.' });
    }
  }

  async function addGroceryItem(rawText: string) {
    const ingredient = parseIngredientLine(rawText);
    const item: GroceryItem = {
      id: makeId('grocery'), ingredientName: ingredient.ingredientName,
      normalizedIngredient: ingredient.normalizedIngredient, quantity: ingredient.quantity,
      unit: ingredient.normalizedUnit, groceryCategory: ingredient.groceryCategory,
      checked: false, manual: true, recipeContributions: [], revision: 0,
      dateModified: new Date().toISOString(),
    };
    setData((current) => ({ ...current, groceryItems: [...current.groceryItems, item] }));
    const saved = await mutate<GroceryItem>('/api/grocery', 'POST', { id: item.id, rawText });
    if (saved) setData((current) => ({ ...current, groceryItems: current.groceryItems.map((row) => row.id === item.id ? saved : row) }));
  }

  async function toggleGroceryItem(item: GroceryItem) {
    const checked = !item.checked;
    const update = (value: boolean) => setData((current) => ({
      ...current,
      groceryItems: current.groceryItems.map((row) => row.id === item.id ? { ...row, checked: value } : row),
    }));
    update(checked);
    showToast(checked ? {
      message: `${item.ingredientName} checked off.`, actionLabel: 'Undo',
      action: () => { update(false); mutate(`/api/grocery/${item.id}`, 'PATCH', { checked: false }); },
    } : { message: `${item.ingredientName} returned to the list.` });
    await mutate(`/api/grocery/${item.id}`, 'PATCH', { checked });
  }

  async function updateGroceryCategory(item: GroceryItem, category: GroceryCategory) {
    setData((current) => ({ ...current, groceryItems: current.groceryItems.map((row) => row.id === item.id ? { ...row, groceryCategory: category } : row) }));
    await mutate(`/api/grocery/${item.id}`, 'PATCH', { groceryCategory: category });
  }

  async function deleteGrocery(item: GroceryItem) {
    setData((current) => ({ ...current, groceryItems: current.groceryItems.filter((row) => row.id !== item.id) }));
    await mutate(`/api/grocery/${item.id}`, 'DELETE');
  }

  async function savePreferences(preferences: HouseholdPreferences) {
    setData((current) => ({ ...current, preferences }));
    await mutate('/api/preferences', 'PUT', preferences);
    setSettingsOpen(false);
    showToast({ message: 'Household preferences saved.' });
  }

  async function exportBackup() {
    try {
      const response = await fetch('/api/backup');
      const blob = response.ok
        ? await response.blob()
        : new Blob([JSON.stringify({ format: 'savor-household-backup', version: 1, exportedAt: new Date().toISOString(), ...data, user: undefined }, null, 2)], { type: 'application/json' });
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
    if (file.size > 5_000_000) throw new Error('Backups must be smaller than 5 MB.');
    const response = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await file.text() });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error || 'Backup could not be imported.');
    await reload();
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
  const syncLabel = syncing ? 'Syncing…' : online ? 'Saved privately' : 'Offline';

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
              <span className={online ? 'sync-pill' : 'sync-pill offline'}>{online ? <Cloud size={14} /> : <WifiOff size={14} />}{syncLabel}</span>
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
            <MealPlannerView recipes={data.recipes} entries={data.mealPlan} onPlanRecipes={planRecipes} onRemoveMeal={removeMeal} onOpenRecipe={setSelectedRecipe} onGenerateGroceries={(entries) => generateGroceries(undefined, entries)} />
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
          onPlan={(date, servings) => planRecipes([selectedFresh.id], date, { [selectedFresh.id]: servings })}
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
          user={data.user}
          preferences={data.preferences}
          installAvailable={Boolean(installPrompt)}
          onInstall={installApp}
          onSave={savePreferences}
          onExport={exportBackup}
          onImport={importBackup}
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

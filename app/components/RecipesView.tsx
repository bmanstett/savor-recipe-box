'use client';

import {
  CalendarPlus, Check, Clock3, Grid2X2, Heart, List, Plus, Search,
  ShoppingBasket, SlidersHorizontal, X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Recipe } from '../../lib/types';

export type Filter = 'all' | 'favorites' | 'quick' | 'recent';

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function RecipesView({
  recipes, query, onQueryChange, filter, onFilterChange, onOpenRecipe, onToggleFavorite, onAddRecipe,
  onPlanRecipes, onGenerateGroceries,
}: {
  recipes: Recipe[];
  query: string;
  onQueryChange: (query: string) => void;
  filter: Filter;
  onFilterChange: (filter: Filter) => void;
  onOpenRecipe: (recipe: Recipe) => void;
  onToggleFavorite: (recipe: Recipe) => void;
  onAddRecipe: () => void;
  onPlanRecipes: (ids: string[], startDate?: string) => Promise<void>;
  onGenerateGroceries: (ids?: string[]) => Promise<void>;
}) {
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [planOpen, setPlanOpen] = useState(false);
  const [startDate, setStartDate] = useState(tomorrow());

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const newestAddedAt = recipes.reduce((latest, recipe) => Math.max(latest, new Date(recipe.dateAdded).getTime()), 0);
    const recentCutoff = newestAddedAt - 1000 * 60 * 60 * 24 * 30;
    return recipes.filter((recipe) => {
      if (filter === 'favorites' && !recipe.favorite) return false;
      if (filter === 'quick' && (recipe.totalTime ?? recipe.cookTime ?? 999) > 30) return false;
      if (filter === 'recent' && new Date(recipe.dateAdded).getTime() < recentCutoff) return false;
      if (!normalizedQuery) return true;
      const haystack = [
        recipe.title, recipe.description, recipe.cuisine, recipe.sourceName, recipe.notes,
        ...recipe.tags, ...recipe.categories,
        ...recipe.ingredients.flatMap((ingredient) => [ingredient.ingredientName, ingredient.rawText]),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [recipes, query, filter]);

  function toggleSelection(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function leaveSelection() {
    setSelecting(false);
    setSelected(new Set());
  }

  async function submitPlan() {
    await onPlanRecipes([...selected], startDate);
    setPlanOpen(false);
    leaveSelection();
  }

  return (
    <section className="recipes-view">
      <div className="recipes-toolbar">
        <label className="mobile-recipe-search">
          <Search size={17} />
          <span className="sr-only">Search recipes</span>
          <input type="search" placeholder="Search your cookbook" value={query} onChange={(event) => onQueryChange(event.target.value)} />
        </label>
        <div className="filter-row" aria-label="Recipe filters">
          {([
            ['all', 'All recipes'], ['favorites', 'Favorites'], ['quick', 'Under 30 min'], ['recent', 'Recently added'],
          ] as Array<[Filter, string]>).map(([id, label]) => (
            <button className={filter === id ? 'filter-chip active' : 'filter-chip'} type="button" key={id} onClick={() => onFilterChange(id)}>{label}</button>
          ))}
          <span className="filter-chip filters-placeholder" title="Search covers cuisine, tags, source, notes, and ingredients"><SlidersHorizontal size={14} /> Search checks every field</span>
        </div>
        <div className="toolbar-actions">
          <div className="layout-toggle" aria-label="Recipe layout">
            <button className={layout === 'grid' ? 'active' : ''} aria-label="Card view" type="button" onClick={() => setLayout('grid')}><Grid2X2 size={16} /></button>
            <button className={layout === 'list' ? 'active' : ''} aria-label="List view" type="button" onClick={() => setLayout('list')}><List size={17} /></button>
          </div>
          <button className={selecting ? 'button button-secondary active-select' : 'button button-secondary'} type="button" onClick={() => selecting ? leaveSelection() : setSelecting(true)}>{selecting ? <><X size={16} />Done</> : <><Check size={16} />Select</>}</button>
          <button className="button button-primary small-add" type="button" onClick={onAddRecipe}><Plus size={16} />Add recipe</button>
        </div>
      </div>

      <div className="recipe-result-count"><span>{visible.length} {visible.length === 1 ? 'recipe' : 'recipes'}</span>{query ? <button type="button" onClick={() => onQueryChange('')}>Clear search</button> : null}</div>

      {visible.length ? (
        <div className={layout === 'grid' ? 'recipe-library-grid' : 'recipe-library-list'}>
          {visible.map((recipe) => {
            const isSelected = selected.has(recipe.id);
            return (
              <article className={isSelected ? 'library-card selected' : 'library-card'} key={recipe.id}>
                <button className="library-card-main" type="button" onClick={() => selecting ? toggleSelection(recipe.id) : onOpenRecipe(recipe)}>
                  <span className="library-image">
                    {recipe.heroImage ? <img alt="" loading="lazy" src={recipe.heroImage} /> : <span className="image-fallback" />}
                    {selecting ? <span className={isSelected ? 'selection-mark selected' : 'selection-mark'}><Check size={15} /></span> : null}
                    {recipe.tags[0] ? <span className="recipe-tag-on-image">{recipe.tags[0]}</span> : null}
                  </span>
                  <span className="library-copy">
                    <strong>{recipe.title}</strong>
                    <small><span><Clock3 size={13} />{recipe.totalTime ?? recipe.cookTime ?? '—'} min</span>{recipe.cuisine ? <span>{recipe.cuisine}</span> : null}{recipe.rating ? <span>{recipe.rating}.0 rated</span> : null}</small>
                    {layout === 'list' ? <span className="list-description">{recipe.description}</span> : null}
                  </span>
                </button>
                <button className={recipe.favorite ? 'card-favorite active' : 'card-favorite'} aria-label={recipe.favorite ? `Remove ${recipe.title} from favorites` : `Add ${recipe.title} to favorites`} type="button" onClick={() => onToggleFavorite(recipe)}><Heart size={17} fill={recipe.favorite ? 'currentColor' : 'none'} /></button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="useful-empty-state">
          <span><Search size={22} /></span>
          <h2>No recipes match that search.</h2>
          <p>Try a title, ingredient, cuisine, tag, source, or note.</p>
          <button className="button button-secondary" type="button" onClick={() => { onQueryChange(''); onFilterChange('all'); }}>Show all recipes</button>
        </div>
      )}

      {selecting && selected.size ? (
        <div className="selection-action-bar" role="region" aria-label="Selected recipe actions">
          <div><strong>{selected.size}</strong><span>{selected.size === 1 ? 'recipe selected' : 'recipes selected'}</span></div>
          <button className="button button-secondary" type="button" onClick={() => setPlanOpen(true)}><CalendarPlus size={17} />Add to meal plan</button>
          <button className="button button-primary" type="button" onClick={async () => { await onGenerateGroceries([...selected]); leaveSelection(); }}><ShoppingBasket size={17} />Create grocery list</button>
        </div>
      ) : null}

      {planOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlanOpen(false); }}>
          <section className="mini-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-plan-title">
            <button className="dialog-x icon-button" aria-label="Close" type="button" onClick={() => setPlanOpen(false)}><X size={18} /></button>
            <p className="eyebrow">Plan {selected.size} {selected.size === 1 ? 'meal' : 'meals'}</p>
            <h2 id="batch-plan-title">Choose the first night.</h2>
            <p>Additional recipes will fill the following nights. You can move them any time.</p>
            <label className="field-label">Starting date<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
            <button className="button button-primary full-button" type="button" onClick={submitPlan}>Add to meal plan</button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

'use client';

import { ArrowRight, CalendarDays, Clock3, Play, ShoppingBasket, Sparkles, Users } from 'lucide-react';
import { MEAL_TYPES, type BootstrapData, type Recipe } from '../../lib/types';

type View = 'home' | 'recipes' | 'plan' | 'grocery';

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function readableDay(date: string): { day: string; date: string } {
  const value = new Date(`${date}T12:00:00`);
  return {
    day: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(value),
    date: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(value),
  };
}

export function HomeView({
  data, onOpenRecipe, onCook, onNavigate, onGenerateGroceries, onAddRecipe, onQuickPick,
}: {
  data: BootstrapData;
  onOpenRecipe: (recipe: Recipe) => void;
  onCook: (recipe: Recipe) => void;
  onNavigate: (view: View) => void;
  onGenerateGroceries: () => void;
  onAddRecipe: () => void;
  onQuickPick: (label: string) => void;
}) {
  if (!data.recipes.length) {
    return (
      <section className="first-run-empty">
        <div className="empty-seal"><Sparkles size={24} /></div>
        <p className="eyebrow">Your private cookbook</p>
        <h2>Your recipes. One place.</h2>
        <p>Save recipes from anywhere, plan the week, and turn every meal into one organized grocery list.</p>
        <div className="empty-actions">
          <button className="button button-primary" type="button" onClick={onAddRecipe}>Import a recipe</button>
          <button className="button button-secondary" type="button" onClick={onAddRecipe}>Scan a recipe</button>
          <button className="button button-ghost" type="button" onClick={onAddRecipe}>Create manually</button>
        </div>
      </section>
    );
  }

  const today = localDateKey(new Date());
  const planned = [...data.mealPlan].sort((a, b) => a.date.localeCompare(b.date)
    || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType));
  const nextEntry = planned.find((entry) => entry.date >= today && data.recipes.some((recipe) => recipe.id === entry.recipeId));
  const nextRecipe = data.recipes.find((recipe) => recipe.id === nextEntry?.recipeId) ?? data.recipes[0];
  const nextMealLabel = nextEntry
    ? `Planned for ${nextEntry.mealType.charAt(0).toUpperCase() + nextEntry.mealType.slice(1)}`
    : 'From your cookbook';
  const upcoming = planned.filter((entry) => entry.id !== nextEntry?.id && entry.date >= today).slice(0, 4);
  const recent = [...data.recipes].sort((a, b) => b.dateAdded.localeCompare(a.dateAdded)).slice(0, 4);
  const remaining = data.groceryItems.filter((item) => !item.checked).length;
  const checked = data.groceryItems.filter((item) => item.checked).length;
  const groceryProgress = data.groceryItems.length ? Math.round((checked / data.groceryItems.length) * 100) : 0;

  return (
    <div className="home-layout">
      <section className="home-primary" aria-labelledby="next-meal-title">
        <div className="section-title-row">
          <div><p className="eyebrow">Next up</p><h2 id="next-meal-title">{nextEntry ? 'Your next meal is decided.' : 'A favorite, ready when you are.'}</h2></div>
          <button className="text-button" type="button" onClick={() => onNavigate('plan')}>View plan <ArrowRight size={15} /></button>
        </div>
        <article className="tonight-hero">
          {nextRecipe.heroImage ? <img alt={nextEntry ? `${nextRecipe.title}, planned for ${nextEntry.mealType}` : nextRecipe.title} src={nextRecipe.heroImage} /> : <div className="image-fallback" />}
          <div className="tonight-shade" />
          <div className="tonight-copy">
            <span className="over-image-label">{nextMealLabel}</span>
            <h3>{nextRecipe.title}</h3>
            <p>{nextRecipe.description}</p>
            <div className="over-image-meta">
              <span><Clock3 size={14} />{nextRecipe.totalTime ?? nextRecipe.cookTime ?? '—'} min</span>
              <span><Users size={14} />Serves {nextEntry?.servings ?? nextRecipe.servings ?? '—'}</span>
            </div>
            <div className="hero-button-row">
              <button className="button light-button" type="button" onClick={() => onCook(nextRecipe)}><Play size={16} fill="currentColor" />Start cooking</button>
              <button className="button glass-button" type="button" onClick={() => onOpenRecipe(nextRecipe)}>View recipe</button>
            </div>
          </div>
        </article>
      </section>

      <aside className="home-aside">
        <section className="upcoming-panel" aria-labelledby="upcoming-title">
          <div className="panel-heading"><div><p className="eyebrow">This week</p><h2 id="upcoming-title">Coming up</h2></div><button className="icon-link" aria-label="Open meal plan" type="button" onClick={() => onNavigate('plan')}><CalendarDays size={18} /></button></div>
          <div className="upcoming-list">
            {upcoming.length ? upcoming.map((entry) => {
              const recipe = data.recipes.find((item) => item.id === entry.recipeId);
              if (!recipe) return null;
              const label = readableDay(entry.date);
              return (
                <button className="upcoming-row" type="button" key={entry.id} onClick={() => onOpenRecipe(recipe)}>
                  <span className="upcoming-date"><strong>{label.day}</strong><small>{label.date}</small></span>
                  {recipe.heroImage ? <img alt="" src={recipe.heroImage} /> : null}
                  <span className="upcoming-copy"><strong>{recipe.title}</strong><small>{recipe.totalTime ?? recipe.cookTime ?? '—'} min · {entry.mealType.charAt(0).toUpperCase() + entry.mealType.slice(1)}</small></span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              );
            }) : <p className="panel-empty">The rest of the week is open.</p>}
          </div>
          <button className="panel-action" type="button" onClick={() => onNavigate('plan')}>Plan another meal <ArrowRight size={15} /></button>
        </section>

        <section className="grocery-progress-card">
          <span className="progress-icon"><ShoppingBasket size={19} /></span>
          <div className="progress-card-copy">
            <p className="eyebrow">Grocery list</p>
            <h3>{remaining ? `${remaining} items left` : 'Ready when you are'}</h3>
            <p>{data.groceryItems.length ? `${groceryProgress}% of this list is complete.` : 'Turn this week’s meals into one aisle-ready list.'}</p>
          </div>
          <div className="progress-track" aria-label={`${groceryProgress}% complete`}><span style={{ width: `${groceryProgress}%` }} /></div>
          <button className="button button-secondary full-button" type="button" onClick={data.groceryItems.length ? () => onNavigate('grocery') : onGenerateGroceries}>
            {data.groceryItems.length ? 'Continue shopping' : 'Generate grocery list'}
          </button>
        </section>
      </aside>

      <section className="home-recent" aria-labelledby="recent-title">
        <div className="section-title-row compact-row">
          <div><p className="eyebrow">Your cookbook</p><h2 id="recent-title">Recently added</h2></div>
          <button className="text-button" type="button" onClick={() => onNavigate('recipes')}>See all recipes <ArrowRight size={15} /></button>
        </div>
        <div className="home-recipe-grid">
          {recent.map((recipe) => (
            <button className="home-recipe-card" type="button" key={recipe.id} onClick={() => onOpenRecipe(recipe)}>
              <span className="home-recipe-image">{recipe.heroImage ? <img alt="" src={recipe.heroImage} /> : <span className="image-fallback" />}{recipe.favorite ? <b>Favorite</b> : null}</span>
              <span className="home-recipe-copy"><strong>{recipe.title}</strong><small>{recipe.totalTime ?? recipe.cookTime ?? '—'} min · {recipe.tags[0] ?? recipe.cuisine ?? 'Recipe'}</small></span>
            </button>
          ))}
        </div>
      </section>

      <section className="quick-picks" aria-label="Quick recipe filters">
        <span>Quick picks</span>
        {['Under 30 minutes', 'Favorites', 'Weeknight', 'Healthy', 'Recently added'].map((label) => (
          <button type="button" key={label} onClick={() => onQuickPick(label)}>{label}</button>
        ))}
      </section>
    </div>
  );
}

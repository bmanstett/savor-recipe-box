'use client';

import { CalendarPlus, ChevronLeft, ChevronRight, Clock3, Plus, ShoppingBasket, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MealPlanEntry, Recipe } from '../../lib/types';

function key(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function startOfWeek(value: Date): Date {
  const result = new Date(value);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

export function MealPlannerView({
  recipes, entries, onPlanRecipes, onRemoveMeal, onOpenRecipe, onGenerateGroceries,
}: {
  recipes: Recipe[];
  entries: MealPlanEntry[];
  onPlanRecipes: (ids: string[], startDate?: string) => Promise<void>;
  onRemoveMeal: (entry: MealPlanEntry) => Promise<void>;
  onOpenRecipe: (recipe: Recipe) => void;
  onGenerateGroceries: (entries: MealPlanEntry[]) => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [chosenDate, setChosenDate] = useState(key(new Date()));
  const [recipeId, setRecipeId] = useState(recipes[0]?.id ?? '');

  const days = useMemo(() => {
    const start = addDays(startOfWeek(new Date()), weekOffset * 7);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [weekOffset]);
  const startKey = key(days[0]);
  const endKey = key(days[6]);
  const weekEntries = entries.filter((entry) => entry.date >= startKey && entry.date <= endKey);
  const plannedRecipeIds = [...new Set(weekEntries.map((entry) => entry.recipeId))];
  const weekLabel = `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(days[0])} – ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(days[6])}`;

  function openAdd(date: string) {
    setChosenDate(date);
    setRecipeId(recipes[0]?.id ?? '');
    setAddOpen(true);
  }

  async function addMeal() {
    if (!recipeId || !chosenDate) return;
    await onPlanRecipes([recipeId], chosenDate);
    setAddOpen(false);
  }

  return (
    <section className="planner-view">
      <div className="planner-toolbar">
        <div className="week-switcher">
          <button className="icon-button" aria-label="Previous week" type="button" onClick={() => setWeekOffset((value) => value - 1)}><ChevronLeft size={19} /></button>
          <div><strong>{weekLabel}</strong><span>{weekEntries.length} planned {weekEntries.length === 1 ? 'meal' : 'meals'}</span></div>
          <button className="icon-button" aria-label="Next week" type="button" onClick={() => setWeekOffset((value) => value + 1)}><ChevronRight size={19} /></button>
          {weekOffset !== 0 ? <button className="today-button" type="button" onClick={() => setWeekOffset(0)}>This week</button> : null}
        </div>
        <div className="planner-actions">
          <button className="button button-secondary" type="button" onClick={() => openAdd(key(new Date()))}><CalendarPlus size={17} />Plan a meal</button>
          <button className="button button-primary" type="button" disabled={!plannedRecipeIds.length} onClick={() => onGenerateGroceries(weekEntries)}><ShoppingBasket size={17} />Make grocery list</button>
        </div>
      </div>

      <div className="week-grid">
        {days.map((day) => {
          const dayKey = key(day);
          const dayEntries = weekEntries.filter((entry) => entry.date === dayKey);
          const isToday = dayKey === key(new Date());
          return (
            <section className={isToday ? 'day-column today' : 'day-column'} key={dayKey} aria-label={new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(day)}>
              <header className="day-header"><span>{new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(day)}</span><strong>{day.getDate()}</strong>{isToday ? <small>Today</small> : null}</header>
              <div className="day-meals">
                {dayEntries.map((entry) => {
                  const recipe = recipes.find((item) => item.id === entry.recipeId);
                  if (!recipe) return null;
                  return (
                    <article className="planned-meal" key={entry.id}>
                      <button className="planned-main" type="button" onClick={() => onOpenRecipe(recipe)}>
                        {recipe.heroImage ? <img alt="" src={recipe.heroImage} /> : <span className="image-fallback" />}
                        <span><small>{entry.mealType}</small><strong>{recipe.title}</strong><em><Clock3 size={12} />{recipe.totalTime ?? recipe.cookTime ?? '—'} min · {entry.servings ?? recipe.servings ?? '—'} servings</em></span>
                      </button>
                      <button className="remove-meal" aria-label={`Remove ${recipe.title} from ${dayKey}`} type="button" onClick={() => onRemoveMeal(entry)}><Trash2 size={14} /></button>
                    </article>
                  );
                })}
                <button className="add-meal-slot" type="button" onClick={() => openAdd(dayKey)}><Plus size={15} />Add meal</button>
              </div>
            </section>
          );
        })}
      </div>

      <section className="planner-summary">
        <div><p className="eyebrow">Week at a glance</p><h2>{plannedRecipeIds.length ? `${plannedRecipeIds.length} dinners, one organized shop.` : 'A blank week is an invitation.'}</h2><p>{plannedRecipeIds.length ? 'Savor will combine overlapping ingredients and keep every recipe contribution visible.' : 'Add a favorite, try something new, or leave room for takeout.'}</p></div>
        <button className="button button-primary" type="button" disabled={!plannedRecipeIds.length} onClick={() => onGenerateGroceries(weekEntries)}><ShoppingBasket size={17} />Generate from this week</button>
      </section>

      {addOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAddOpen(false); }}>
          <section className="mini-dialog plan-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-dialog-title">
            <button className="dialog-x icon-button" aria-label="Close" type="button" onClick={() => setAddOpen(false)}><X size={18} /></button>
            <p className="eyebrow">Meal plan</p>
            <h2 id="plan-dialog-title">What sounds good?</h2>
            <label className="field-label">Recipe<select value={recipeId} onChange={(event) => setRecipeId(event.target.value)}>{recipes.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipe.title}</option>)}</select></label>
            <label className="field-label">Date<input type="date" value={chosenDate} onChange={(event) => setChosenDate(event.target.value)} /></label>
            <button className="button button-primary full-button" type="button" disabled={!recipeId} onClick={addMeal}>Add dinner</button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

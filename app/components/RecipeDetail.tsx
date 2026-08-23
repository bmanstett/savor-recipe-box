'use client';

import {
  CalendarPlus, Check, ChevronLeft, Clock3, Copy, Edit3, ExternalLink,
  Heart, Minus, MoreHorizontal, Plus, Printer, Share2, ShoppingBasket,
  Star, Trash2, Users, Utensils, X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatIngredient, rational } from '../../lib/domain';
import { MEAL_TYPES, type MealType, type Recipe } from '../../lib/types';

type Toast = { message: string; actionLabel?: string; action?: () => void } | null;

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function RecipeDetail({
  recipe, onClose, onCook, onFavorite, onPlan, onGroceries, onEdit,
  onDuplicate, onDelete, showToast,
}: {
  recipe: Recipe;
  onClose: () => void;
  onCook: () => void;
  onFavorite: () => void;
  onPlan: (date: string, servings: number, mealType: MealType) => void;
  onGroceries: (servings: number) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  showToast: (toast: Toast) => void;
}) {
  const [servings, setServings] = useState(recipe.servings ?? 4);
  const [planOpen, setPlanOpen] = useState(false);
  const [planDate, setPlanDate] = useState(tomorrow());
  const [mealType, setMealType] = useState<MealType>('dinner');
  const [moreOpen, setMoreOpen] = useState(false);
  const factor = recipe.servings ? rational(servings, recipe.servings) : rational(1);
  const ingredientGroups = useMemo(() => {
    const groups = new Map<string, typeof recipe.ingredients>();
    recipe.ingredients.forEach((ingredient) => {
      const key = ingredient.section ?? 'Ingredients';
      groups.set(key, [...(groups.get(key) ?? []), ingredient]);
    });
    return [...groups.entries()];
  }, [recipe]);

  async function share() {
    const shareData = {
      title: recipe.title,
      text: `${recipe.title}\n${recipe.description}`,
      url: recipe.sourceURL ?? window.location.href,
    };
    try {
      if (navigator.share) await navigator.share(shareData);
      else {
        await navigator.clipboard.writeText(`${shareData.title}\n${shareData.text}\n${shareData.url}`);
        showToast({ message: 'Recipe details copied to the clipboard.' });
      }
    } catch { /* The user may cancel the platform share sheet. */ }
  }

  function confirmDelete() {
    if (window.confirm(`Delete “${recipe.title}”? You can undo for a few seconds.`)) onDelete();
  }

  return (
    <section className="recipe-detail-layer" role="dialog" aria-modal="true" aria-labelledby="recipe-detail-title">
      <header className="detail-topbar">
        <button className="detail-back" type="button" onClick={onClose}><ChevronLeft size={19} />Back to cookbook</button>
        <div className="detail-top-actions">
          <button className="icon-button" aria-label="Share recipe" type="button" onClick={share}><Share2 size={18} /></button>
          <button className="icon-button print-button" aria-label="Print recipe" type="button" onClick={() => window.print()}><Printer size={18} /></button>
          <div className="more-menu-wrap">
            <button className="icon-button" aria-label="More recipe actions" aria-expanded={moreOpen} type="button" onClick={() => setMoreOpen((value) => !value)}><MoreHorizontal size={20} /></button>
            {moreOpen ? <div className="more-menu"><button type="button" onClick={onDuplicate}><Copy size={15} />Duplicate</button><button className="destructive" type="button" onClick={confirmDelete}><Trash2 size={15} />Delete recipe</button></div> : null}
          </div>
          <button className="detail-close icon-button" aria-label="Close recipe" type="button" onClick={onClose}><X size={20} /></button>
        </div>
      </header>

      <div className="detail-scroll">
        <section className="detail-hero">
          <div className="detail-image">
            {recipe.heroImage ? <img alt={`${recipe.title}, finished dish`} src={recipe.heroImage} /> : <span className="image-fallback" />}
            <button className={recipe.favorite ? 'detail-favorite active' : 'detail-favorite'} aria-label={recipe.favorite ? 'Remove from favorites' : 'Add to favorites'} type="button" onClick={onFavorite}><Heart size={19} fill={recipe.favorite ? 'currentColor' : 'none'} /></button>
          </div>
          <div className="detail-intro">
            <div className="detail-source-row">
              <span>{recipe.cuisine ?? recipe.categories[0] ?? 'Recipe'}</span>
              {recipe.rating ? <span className="rating"><Star size={13} fill="currentColor" />{recipe.rating}.0</span> : null}
            </div>
            <h1 id="recipe-detail-title">{recipe.title}</h1>
            <p>{recipe.description}</p>
            {recipe.sourceURL ? <a className="source-link" href={recipe.sourceURL} target="_blank" rel="noreferrer">{recipe.sourceName ?? new URL(recipe.sourceURL).hostname}<ExternalLink size={13} /></a> : recipe.sourceName ? <span className="source-link static-source">{recipe.sourceName}</span> : null}
            <div className="detail-meta-grid">
              <span><small>Prep</small><strong>{recipe.prepTime ?? '—'} min</strong></span>
              <span><small>Cook</small><strong>{recipe.cookTime ?? '—'} min</strong></span>
              <span><small>Total</small><strong>{recipe.totalTime ?? '—'} min</strong></span>
              <span><small>Made</small><strong>{recipe.timesCooked} {recipe.timesCooked === 1 ? 'time' : 'times'}</strong></span>
            </div>
            <div className="detail-primary-actions">
              <button className="button button-primary cook-now" type="button" onClick={onCook}><Utensils size={17} />Cook now</button>
              <button className="button button-secondary" type="button" onClick={() => setPlanOpen(true)}><CalendarPlus size={17} />Plan</button>
              <button className="button button-secondary grocery-action" type="button" onClick={() => onGroceries(servings)}><ShoppingBasket size={17} />Groceries</button>
              <button className="button button-ghost edit-action" type="button" onClick={onEdit}><Edit3 size={16} />Edit</button>
            </div>
          </div>
        </section>

        <div className="recipe-body-grid">
          <aside className="ingredients-column">
            <div className="ingredients-heading">
              <div><p className="eyebrow">Mise en place</p><h2>Ingredients</h2></div>
              <div className="servings-control" aria-label="Adjust servings">
                <button aria-label="Decrease servings" type="button" onClick={() => setServings((value) => Math.max(1, value - 1))}><Minus size={14} /></button>
                <span><Users size={14} /><strong>{servings}</strong><small>servings</small></span>
                <button aria-label="Increase servings" type="button" onClick={() => setServings((value) => value + 1)}><Plus size={14} /></button>
              </div>
            </div>
            {ingredientGroups.map(([section, ingredients]) => (
              <section className="ingredient-group" key={section}>
                {ingredientGroups.length > 1 || section !== 'Ingredients' ? <h3>{section}</h3> : null}
                <ul>{ingredients.map((ingredient) => <li className={ingredient.needsReview ? 'needs-review' : ''} key={ingredient.id}><span className="ingredient-check"><Check size={13} /></span><span>{formatIngredient(ingredient, factor)}</span>{ingredient.optional ? <small>optional</small> : null}</li>)}</ul>
              </section>
            ))}
            <button className="button button-secondary full-button ingredient-list-action" type="button" onClick={() => onGroceries(servings)}><ShoppingBasket size={16} />Add these ingredients to groceries</button>
          </aside>

          <section className="instructions-column" aria-labelledby="instructions-title">
            <div className="instructions-heading"><div><p className="eyebrow">Method</p><h2 id="instructions-title">Instructions</h2></div><button className="button button-primary" type="button" onClick={onCook}>Enter cooking mode</button></div>
            <ol className="instruction-list">
              {recipe.instructions.map((instruction) => (
                <li key={instruction.id}>
                  <span>{String(instruction.stepNumber).padStart(2, '0')}</span>
                  <div>{instruction.section ? <small>{instruction.section}</small> : null}<p>{instruction.text}</p>{instruction.timerMinutes ? <span className="timer-suggestion"><Clock3 size={14} />Suggested timer · {instruction.timerMinutes} minutes</span> : null}</div>
                </li>
              ))}
            </ol>
            {recipe.notes ? <aside className="recipe-note"><p className="eyebrow">Kitchen note</p><p>{recipe.notes}</p></aside> : null}
          </section>
        </div>
      </div>

      {planOpen ? (
        <div className="dialog-backdrop nested-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlanOpen(false); }}>
          <section className="mini-dialog" role="dialog" aria-modal="true" aria-labelledby="detail-plan-title">
            <button className="dialog-x icon-button" aria-label="Close" type="button" onClick={() => setPlanOpen(false)}><X size={18} /></button>
            <p className="eyebrow">Add to meal plan</p><h2 id="detail-plan-title">Choose when to serve it.</h2>
            <p>{recipe.title} · {servings} servings</p>
            <label className="field-label">Date<input type="date" value={planDate} onChange={(event) => setPlanDate(event.target.value)} /></label>
            <label className="field-label">Meal type<select value={mealType} onChange={(event) => setMealType(event.target.value as MealType)}>{MEAL_TYPES.map((type) => <option value={type} key={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</option>)}</select></label>
            <button className="button button-primary full-button" type="button" onClick={() => { onPlan(planDate, servings, mealType); setPlanOpen(false); }}>Add to meal plan</button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

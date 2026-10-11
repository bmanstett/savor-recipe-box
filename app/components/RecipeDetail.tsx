'use client';

import {
  CalendarPlus, Check, ChevronLeft, Clock3, Copy, Edit3, ExternalLink,
  Heart, Instagram, Link2, Minus, MoreHorizontal, Plus, Printer, Share2, ShoppingBasket,
  Star, Trash2, Users, Utensils, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatIngredient, rational } from '../../lib/domain';
import { MEAL_TYPES, type MealType, type Recipe, type RecipeSourceLink } from '../../lib/types';

type Toast = { message: string; actionLabel?: string; action?: () => void } | null;

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isInstagramUrl(url: string): boolean {
  const host = hostOf(url);
  return host === 'instagram.com' || Boolean(host?.endsWith('.instagram.com'));
}

interface SourceEntry {
  url: string;
  title: string;
  detail: string;
  kind: 'primary' | RecipeSourceLink['kind'];
}

// The saved link is the thing a cook wants mid-recipe, so it is shown as a
// real button rather than a small text link, with any linked recipe page
// (for Instagram posts whose recipe lives on the creator's site) beside it.
function sourceEntries(recipe: Recipe): SourceEntry[] {
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();
  if (recipe.sourceURL && hostOf(recipe.sourceURL)) {
    const host = hostOf(recipe.sourceURL) ?? '';
    const instagram = isInstagramUrl(recipe.sourceURL);
    entries.push({
      url: recipe.sourceURL,
      title: instagram ? 'Open the original post' : `Open on ${recipe.sourceName && recipe.sourceName !== host ? recipe.sourceName : host}`,
      detail: instagram ? (recipe.author ? `Instagram · ${recipe.author}` : 'Instagram') : host,
      kind: 'primary',
    });
    seen.add(recipe.sourceURL);
  }
  for (const link of recipe.sourceLinks ?? []) {
    if (seen.has(link.url) || !hostOf(link.url)) continue;
    if (link.kind === 'creator-profile') continue;
    seen.add(link.url);
    const host = hostOf(link.url) ?? '';
    entries.push({
      url: link.url,
      title: link.kind === 'recipe-page' ? `Full recipe on ${host}` : link.label,
      detail: link.kind === 'recipe-page' ? 'Linked from the post' : host,
      kind: link.kind,
    });
  }
  return entries;
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
  const [gathered, setGathered] = useState<Set<string>>(() => new Set());
  const factor = recipe.servings ? rational(servings, recipe.servings) : rational(1);

  function toggleGathered(id: string) {
    setGathered((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const ingredientGroups = useMemo(() => {
    const groups = new Map<string, typeof recipe.ingredients>();
    recipe.ingredients.forEach((ingredient) => {
      const key = ingredient.section ?? 'Ingredients';
      groups.set(key, [...(groups.get(key) ?? []), ingredient]);
    });
    return [...groups.entries()];
  }, [recipe]);
  const sources = useMemo(() => sourceEntries(recipe), [recipe]);
  const creatorProfile = (recipe.sourceLinks ?? []).find((link) => link.kind === 'creator-profile' && hostOf(link.url));

  useEffect(() => {
    if (!moreOpen && !planOpen) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Swallow the key so the detail layer underneath does not close as well.
      event.stopImmediatePropagation();
      setMoreOpen(false);
      setPlanOpen(false);
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [moreOpen, planOpen]);

  async function share() {
    const shareData = {
      title: recipe.title,
      text: recipe.sourceURL ? `${recipe.title}` : `${recipe.title}\n${recipe.description}`,
      ...(recipe.sourceURL ? { url: recipe.sourceURL } : {}),
    };
    try {
      if (navigator.share) await navigator.share(shareData);
      else {
        await navigator.clipboard.writeText([shareData.title, recipe.description, recipe.sourceURL ?? ''].filter(Boolean).join('\n'));
        showToast({ message: 'Recipe details copied to the clipboard.' });
      }
    } catch { /* The user may cancel the platform share sheet. */ }
  }

  async function copySourceLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      showToast({ message: 'Link copied.' });
    } catch {
      showToast({ message: 'The link could not be copied on this device.' });
    }
  }

  function confirmDelete() {
    setMoreOpen(false);
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
            {moreOpen ? (
              <>
                <div className="more-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); onDuplicate(); }}><Copy size={15} />Duplicate</button>
                  {recipe.sourceURL ? <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void copySourceLink(recipe.sourceURL ?? ''); }}><Link2 size={15} />Copy source link</button> : null}
                  <button className="destructive" type="button" role="menuitem" onClick={confirmDelete}><Trash2 size={15} />Delete recipe</button>
                </div>
              </>
            ) : null}
          </div>
          <button className="detail-close icon-button" aria-label="Close recipe" type="button" onClick={onClose}><X size={20} /></button>
        </div>
      </header>
      {/* The scrim lives outside the blurred top bar, which would otherwise clip it to its own box. */}
      {moreOpen ? <button className="menu-scrim" aria-label="Close menu" type="button" onClick={() => setMoreOpen(false)} /> : null}

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
            {recipe.description ? <p>{recipe.description}</p> : null}
            {recipe.author ? <span className="recipe-author">By {recipe.author}</span> : recipe.sourceName && !recipe.sourceURL ? <span className="recipe-author">{recipe.sourceName}</span> : null}

            {sources.length ? (
              <div className="source-cards" aria-label="Where this recipe came from">
                {sources.map((source) => (
                  <a className={source.kind === 'primary' ? 'source-card primary' : 'source-card'} href={source.url} target="_blank" rel="noreferrer" key={source.url}>
                    <span className="source-card-icon">{isInstagramUrl(source.url) ? <Instagram size={18} /> : <Link2 size={18} />}</span>
                    <span className="source-card-copy"><strong>{source.title}</strong><small>{source.detail}</small></span>
                    <ExternalLink size={15} aria-hidden="true" />
                  </a>
                ))}
                {creatorProfile ? <a className="source-link" href={creatorProfile.url} target="_blank" rel="noreferrer">{creatorProfile.label}<ExternalLink size={13} /></a> : null}
              </div>
            ) : null}

            <div className="detail-meta-grid">
              <span><small>Prep</small><strong>{recipe.prepTime ?? '—'} min</strong></span>
              <span><small>Cook</small><strong>{recipe.cookTime ?? '—'} min</strong></span>
              <span><small>Total</small><strong>{recipe.totalTime ?? '—'} min</strong></span>
              <span><small>Made</small><strong>{recipe.timesCooked} {recipe.timesCooked === 1 ? 'time' : 'times'}</strong></span>
            </div>
            <div className="detail-primary-actions">
              <button className="button button-primary cook-now" type="button" onClick={onCook}><Utensils size={17} />Cook now</button>
              <button className="button button-secondary" type="button" onClick={() => setPlanOpen(true)}><CalendarPlus size={17} />Plan</button>
              <button className="button button-secondary grocery-action" type="button" aria-label="Add ingredients to groceries" onClick={() => onGroceries(servings)}><ShoppingBasket size={17} />Groceries</button>
              <button className="button button-ghost edit-action" type="button" aria-label="Edit recipe" onClick={onEdit}><Edit3 size={16} />Edit</button>
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
                <ul>{ingredients.map((ingredient) => {
                  const done = gathered.has(ingredient.id);
                  return (
                    <li className={[ingredient.needsReview ? 'needs-review' : '', done ? 'gathered' : ''].join(' ').trim()} key={ingredient.id}>
                      <button className="ingredient-toggle" type="button" aria-pressed={done} onClick={() => toggleGathered(ingredient.id)}>
                        <span className="ingredient-check"><Check size={13} /></span>
                        <span>{formatIngredient(ingredient, factor)}</span>
                        {ingredient.optional ? <small>optional</small> : null}
                      </button>
                    </li>
                  );
                })}</ul>
              </section>
            ))}
            {!recipe.ingredients.length ? <p className="panel-empty">No ingredients were saved for this recipe yet.</p> : null}
            <button className="button button-secondary full-button ingredient-list-action" type="button" onClick={() => onGroceries(servings)}><ShoppingBasket size={16} />Add these ingredients to groceries</button>
          </aside>

          <section className="instructions-column" aria-labelledby="instructions-title">
            <div className="instructions-heading"><div><p className="eyebrow">Method</p><h2 id="instructions-title">Instructions</h2></div><button className="button button-primary" type="button" onClick={onCook}>Enter cooking mode</button></div>
            {recipe.instructions.length ? (
              <ol className="instruction-list">
                {recipe.instructions.map((instruction) => (
                  <li key={instruction.id}>
                    <span>{String(instruction.stepNumber).padStart(2, '0')}</span>
                    <div>{instruction.section ? <small>{instruction.section}</small> : null}<p>{instruction.text}</p>{instruction.timerMinutes ? <span className="timer-suggestion"><Clock3 size={14} />Suggested timer · {instruction.timerMinutes} minutes</span> : null}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="instructions-empty">
                <p>No steps were saved. {recipe.sourceURL ? 'The original post or page may show them in a video or comment.' : 'Add them from Edit when you are ready.'}</p>
                {recipe.sourceURL ? <a className="button button-secondary" href={recipe.sourceURL} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open the original</a> : null}
                <button className="button button-ghost" type="button" onClick={onEdit}><Edit3 size={15} />Add steps</button>
              </div>
            )}
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
            <label className="field-label">Date<input type="date" required value={planDate} onChange={(event) => setPlanDate(event.target.value)} /></label>
            <label className="field-label">Meal type<select value={mealType} onChange={(event) => setMealType(event.target.value as MealType)}>{MEAL_TYPES.map((type) => <option value={type} key={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</option>)}</select></label>
            <button className="button button-primary full-button" type="button" disabled={!planDate} onClick={() => { onPlan(planDate, servings, mealType); setPlanOpen(false); }}>Add to meal plan</button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

'use client';

import { BookOpen, CalendarClock, CheckCircle2, ClipboardList, ShieldAlert, Snowflake, X } from 'lucide-react';
import { useMemo } from 'react';
import type {
  MealWeekRecommendation, SundayPrepTask, SundayPrepWarning,
} from '../../lib/meal-week-optimizer';
import type { Recipe } from '../../lib/types';

function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function formatDate(value: string, includeWeekday = true): string {
  const parsed = parseDate(value);
  if (Number.isNaN(parsed.getTime())) return value || 'Unknown date';
  return new Intl.DateTimeFormat('en-US', {
    weekday: includeWeekday ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
  }).format(parsed);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function confidenceLabel(level: 'high' | 'medium' | 'low'): string {
  if (level === 'high') return 'Strong recipe match';
  if (level === 'medium') return 'Good recipe estimate';
  return 'Best recipe estimate';
}

interface PrepRecipeGroup {
  recipeId: string;
  recipe: Recipe | null;
  recipeTitle: string;
  plannedFor: string[];
  firstDate: string;
  tasks: SundayPrepTask[];
  warnings: SundayPrepWarning[];
}

export function SundayPrepDialog({
  recommendation,
  recipes,
  onClose,
  onOpenRecipe,
}: {
  recommendation: MealWeekRecommendation;
  recipes: readonly Recipe[];
  onClose: () => void;
  onOpenRecipe: (recipe: Recipe) => void;
}) {
  const groups = useMemo(() => {
    const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    const grouped = new Map<string, PrepRecipeGroup>();
    for (const meal of recommendation.schedule) {
      const existing = grouped.get(meal.recipeId);
      const plannedLabel = `${titleCase(meal.mealType)} · ${formatDate(meal.date)}`;
      if (existing) {
        if (!existing.plannedFor.includes(plannedLabel)) existing.plannedFor.push(plannedLabel);
        if (meal.date < existing.firstDate) existing.firstDate = meal.date;
      } else {
        grouped.set(meal.recipeId, {
          recipeId: meal.recipeId,
          recipe: recipesById.get(meal.recipeId) ?? null,
          recipeTitle: meal.recipeTitle,
          plannedFor: [plannedLabel],
          firstDate: meal.date,
          tasks: [],
          warnings: [],
        });
      }
    }
    for (const task of recommendation.sundayPrep.tasks) {
      grouped.get(task.recipeId)?.tasks.push(task);
    }
    for (const warning of recommendation.sundayPrep.warnings) {
      grouped.get(warning.recipeId)?.warnings.push(warning);
    }
    return [...grouped.values()].sort((first, second) => (
      first.firstDate.localeCompare(second.firstDate) || first.recipeTitle.localeCompare(second.recipeTitle)
    ));
  }, [recommendation, recipes]);

  const taskCount = recommendation.sundayPrep.tasks.length;
  const recipeCount = groups.filter((group) => group.tasks.length || group.warnings.length).length;

  return (
    <div className="dialog-backdrop optimize-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="optimize-dialog prep-dialog" role="dialog" aria-modal="true" aria-labelledby="sunday-prep-dialog-title" aria-describedby="sunday-prep-dialog-description" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
        <header className="optimize-dialog-header">
          <div className="optimize-title-mark prep-title-mark"><ClipboardList size={21} /></div>
          <div>
            <p className="eyebrow">Sunday · {formatDate(recommendation.sundayPrep.date, false)}</p>
            <h2 id="sunday-prep-dialog-title">Prep once, coast all week</h2>
            <p id="sunday-prep-dialog-description">Keep this open as your Sunday quick reference. Suggestions follow the meal dates currently saved in your planner.</p>
          </div>
          <button className="dialog-x icon-button" aria-label="Close Sunday prep" type="button" autoFocus onClick={onClose}><X size={18} /></button>
        </header>

        <div className="optimize-scroll prep-dialog-scroll">
          <section className="prep-overview" aria-label="Sunday prep summary">
            <div className="prep-date-seal"><small>Sunday</small><strong>{parseDate(recommendation.sundayPrep.date).getDate()}</strong></div>
            <div>
              <strong>{taskCount ? `${taskCount} prep ${taskCount === 1 ? 'step' : 'steps'} across ${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'}` : 'No advance prep is required'}</strong>
              <span>{confidenceLabel(recommendation.sundayPrep.confidence.level)} · based on structured recipe ingredients and instructions</span>
            </div>
          </section>

          <div className="prep-recipe-list">
            {groups.map((group) => (
              <article className="prep-recipe-card" key={group.recipeId}>
                <header className="prep-recipe-header">
                  {group.recipe?.heroImage ? <img alt="" src={group.recipe.heroImage} /> : <span className="prep-recipe-image image-fallback" />}
                  <div>
                    <small>{group.plannedFor.join(' · ')}</small>
                    <h3>{group.recipeTitle}</h3>
                  </div>
                  {group.recipe ? <button className="button button-secondary prep-recipe-button" aria-label={`View full recipe: ${group.recipeTitle}`} type="button" onClick={() => onOpenRecipe(group.recipe!)}><BookOpen size={15} />View full recipe</button> : null}
                </header>

                {group.tasks.length ? (
                  <section className="prep-card-section" aria-label={`Sunday tasks for ${group.recipeTitle}`}>
                    <h4><CheckCircle2 size={15} />Prep on Sunday</h4>
                    <ol className="prep-task-list prep-task-list-grouped">
                      {group.tasks.map((task) => (
                        <li key={task.id}>
                          <span>{task.kind === 'portion-lunch' ? <Snowflake size={15} /> : task.kind === 'marinate' ? <CalendarClock size={15} /> : <CheckCircle2 size={15} />}</span>
                          <div>
                            <strong>{task.instruction}</strong>
                            {task.reasons[0] ? <p>{task.reasons[0]}</p> : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : (
                  <p className="prep-day-of-note">No safe advance step was identified. Open the recipe and prepare this meal closer to serving.</p>
                )}

                {group.warnings.length ? (
                  <section className="prep-warning-list prep-warning-list-grouped" aria-label={`Storage notes for ${group.recipeTitle}`}>
                    <h4><ShieldAlert size={15} />Wait until closer to serving</h4>
                    {group.warnings.map((warning) => (
                      <article key={warning.id}><p>{warning.message} <strong>{warning.recommendation}</strong></p></article>
                    ))}
                  </section>
                ) : null}
              </article>
            ))}
          </div>

          {recommendation.unresolvedEntries.length ? (
            <aside className="prep-unresolved"><ShieldAlert size={17} /><p>{recommendation.unresolvedEntries.length} planned {recommendation.unresolvedEntries.length === 1 ? 'meal could' : 'meals could'} not be included because the date or recipe needs attention.</p></aside>
          ) : null}

          <aside className="optimizer-safety-note">
            <ShieldAlert size={17} />
            <p><strong>Food-safety reminder:</strong> Keep the refrigerator at 40°F or below, follow package use-by dates, and freeze later-week portions when recommended. These are conservative suggestions; inspect ingredients before using them.</p>
          </aside>
        </div>

        <footer className="optimize-footer prep-footer">
          <p>Reopen Sunday prep from the meal planner whenever you need this checklist.</p>
          <div><button className="button button-primary" type="button" onClick={onClose}>Done</button></div>
        </footer>
      </section>
    </div>
  );
}

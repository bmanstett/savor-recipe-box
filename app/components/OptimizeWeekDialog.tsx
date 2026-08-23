'use client';

import {
  ArrowRight, CalendarClock, CheckCircle2, ShieldAlert, Sparkles, X,
} from 'lucide-react';
import { useState } from 'react';
import type { MealWeekRecommendation, RecommendedMeal } from '../../lib/meal-week-optimizer';

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
  return value.replace(/(^|-)(\w)/g, (_match, separator: string, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`);
}

function confidenceLabel(level: 'high' | 'medium' | 'low'): string {
  if (level === 'high') return 'Strong match';
  if (level === 'medium') return 'Good estimate';
  return 'Best estimate';
}

export function OptimizeWeekDialog({
  recommendation,
  onClose,
  onApply,
}: {
  recommendation: MealWeekRecommendation;
  onClose: () => void;
  onApply: (schedule: readonly RecommendedMeal[]) => Promise<void>;
}) {
  const [applying, setApplying] = useState(false);
  const movedCount = recommendation.schedule.filter((meal) => meal.moved).length;
  const coverage = Math.round(recommendation.dataQuality.purchaseCoverage * 100);

  async function applySchedule() {
    setApplying(true);
    try {
      await onApply(recommendation.schedule);
      onClose();
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="dialog-backdrop optimize-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="optimize-dialog schedule-only-dialog" role="dialog" aria-modal="true" aria-labelledby="optimize-dialog-title">
        <header className="optimize-dialog-header">
          <div className="optimize-title-mark"><Sparkles size={21} /></div>
          <div>
            <p className="eyebrow">Freshness-aware week</p>
            <h2 id="optimize-dialog-title">A smarter order for your meals</h2>
            <p>See what to eat when based on grocery purchase timing and conservative freshness windows. Nothing moves until you apply the schedule.</p>
          </div>
          <button className="dialog-x icon-button" aria-label="Close optimizer" type="button" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="optimize-scroll">
          <section className={`optimization-confidence confidence-${recommendation.dataQuality.confidence.level}`} aria-label="Recommendation confidence">
            <div>
              <strong>{confidenceLabel(recommendation.dataQuality.confidence.level)}</strong>
              <span>{coverage}% of planned ingredient needs have a recorded purchase time · {recommendation.dataQuality.matchedIngredients} of {recommendation.dataQuality.totalIngredients} ingredients matched to this grocery list</span>
            </div>
            <b>{recommendation.dataQuality.confidence.score}%</b>
          </section>

          {recommendation.dataQuality.reasons.length ? (
            <p className="optimizer-assumption">{recommendation.dataQuality.reasons.join(' ')}</p>
          ) : null}

          <section className="optimizer-panel schedule-panel schedule-panel-only" aria-labelledby="optimized-schedule-title">
            <div className="optimizer-panel-heading">
              <span><CalendarClock size={18} /></span>
              <div><p className="eyebrow">Recommended schedule</p><h3 id="optimized-schedule-title">What to eat when</h3></div>
            </div>
            <div className="optimized-meal-list">
              {recommendation.schedule.map((meal) => (
                <article className="optimized-meal" key={meal.sourceEntryId}>
                  <div className="optimized-date">
                    <small>{new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(parseDate(meal.date))}</small>
                    <strong>{parseDate(meal.date).getDate()}</strong>
                  </div>
                  <div className="optimized-meal-copy">
                    <span className="optimized-meal-meta"><b>{titleCase(meal.mealType)}</b><em>{titleCase(meal.freshness.category)}</em></span>
                    <h4>{meal.recipeTitle}</h4>
                    <p>{meal.reasons[0] ?? 'Placed here to balance freshness and your existing plan.'}</p>
                    {meal.moved ? (
                      <span className="meal-move"><span>{formatDate(meal.originalDate)}</span><ArrowRight size={12} /><strong>{formatDate(meal.date)}</strong></span>
                    ) : <span className="meal-keep"><CheckCircle2 size={12} />Keep on {formatDate(meal.date)}</span>}
                  </div>
                </article>
              ))}
              {recommendation.unresolvedEntries.map((entry) => (
                <article className="optimized-meal unresolved-meal" key={entry.sourceEntryId}>
                  <div className="optimized-date"><ShieldAlert size={17} /></div>
                  <div className="optimized-meal-copy"><h4>Plan entry needs attention</h4><p>{entry.reason === 'missing-recipe' ? `A planned entry on ${formatDate(entry.originalDate)} references a recipe that is no longer available.` : `A planned entry has an invalid date (${entry.originalDate || 'blank'}) and could not be optimized.`}</p></div>
                </article>
              ))}
            </div>
          </section>

          <aside className="optimizer-safety-note">
            <ShieldAlert size={17} />
            <p><strong>Food-safety reminder:</strong> Keep the refrigerator at 40°F or below, follow package use-by dates, and freeze later-week portions when recommended. This plan is a conservative guide, not a freshness guarantee.</p>
          </aside>
        </div>

        <footer className="optimize-footer">
          <p>{movedCount ? `${movedCount} ${movedCount === 1 ? 'meal' : 'meals'} will move. Nothing changes until you apply this schedule.` : 'Your current meal order already fits the freshness recommendation.'}</p>
          <div>
            <button className="button button-ghost" type="button" onClick={onClose}>{movedCount ? 'Keep current plan' : 'Close'}</button>
            {movedCount ? <button className="button button-primary" type="button" disabled={applying} onClick={applySchedule}><Sparkles size={16} />{applying ? 'Applying…' : 'Apply suggested days'}</button> : null}
          </div>
        </footer>
      </section>
    </div>
  );
}

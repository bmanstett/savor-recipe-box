'use client';

import {
  Check, ChevronLeft, ChevronRight, Clock3, ListChecks, Moon, Pause,
  Play, RotateCcw, Sun, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatIngredient } from '../../lib/domain';
import type { Recipe } from '../../lib/types';

type Toast = { message: string; actionLabel?: string; action?: () => void } | null;
type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener: (type: string, listener: () => void) => void };

export function CookingMode({ recipe, onClose, onFinish, showToast }: {
  recipe: Recipe;
  onClose: () => void;
  onFinish: () => void;
  showToast: (toast: Toast) => void;
}) {
  const [step, setStep] = useState(0);
  const [ingredientsOpen, setIngredientsOpen] = useState(true);
  const [checkedIngredients, setCheckedIngredients] = useState<Set<string>>(new Set());
  const [seconds, setSeconds] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [awake, setAwake] = useState(false);
  const wakeLock = useRef<WakeLockSentinelLike | null>(null);
  const current = recipe.instructions[step];
  const total = recipe.instructions.length;

  useEffect(() => {
    if (!running || seconds === null) return;
    const timer = window.setInterval(() => setSeconds((value) => {
      if (value === null) return null;
      if (value <= 1) {
        window.clearInterval(timer);
        window.setTimeout(() => {
          setRunning(false);
          showToast({ message: 'Timer finished.' });
          if ('vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
        }, 0);
        return 0;
      }
      return value - 1;
    }), 1_000);
    return () => window.clearInterval(timer);
  }, [running, seconds, showToast]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') setStep((value) => Math.min(total - 1, value + 1));
      if (event.key === 'ArrowLeft') setStep((value) => Math.max(0, value - 1));
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose, total]);

  useEffect(() => () => { wakeLock.current?.release().catch(() => undefined); }, []);

  const timerLabel = useMemo(() => {
    if (seconds === null) return '';
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, [seconds]);

  async function toggleAwake() {
    if (awake) {
      await wakeLock.current?.release();
      wakeLock.current = null;
      setAwake(false);
      return;
    }
    const manager = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!manager) {
      showToast({ message: 'Screen wake lock is not supported on this device.' });
      return;
    }
    try {
      wakeLock.current = await manager.request('screen');
      wakeLock.current.addEventListener('release', () => setAwake(false));
      setAwake(true);
      showToast({ message: 'Screen will stay awake while you cook.' });
    } catch {
      showToast({ message: 'Savor could not keep the screen awake.' });
    }
  }

  function startSuggestedTimer() {
    if (!current?.timerMinutes) return;
    setSeconds(current.timerMinutes * 60);
    setRunning(true);
  }

  function toggleIngredient(id: string) {
    setCheckedIngredients((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (!current) return null;

  return (
    <section className="cooking-mode" role="dialog" aria-modal="true" aria-labelledby="cooking-title">
      <header className="cooking-header">
        <div><p className="eyebrow">Cooking mode</p><h1 id="cooking-title">{recipe.title}</h1></div>
        <div className="cooking-header-actions">
          <button className={awake ? 'cooking-tool active' : 'cooking-tool'} type="button" aria-pressed={awake} onClick={toggleAwake}>{awake ? <Sun size={17} /> : <Moon size={17} />}<span>{awake ? 'Screen awake' : 'Keep awake'}</span></button>
          <button className="icon-button cooking-close" aria-label="Exit cooking mode" type="button" onClick={onClose}><X size={21} /></button>
        </div>
      </header>

      <div className="cooking-progress" aria-label={`Step ${step + 1} of ${total}`}><span style={{ width: `${((step + 1) / total) * 100}%` }} /></div>

      <div className={ingredientsOpen ? 'cooking-layout ingredients-visible' : 'cooking-layout'}>
        <aside className="cooking-ingredients">
          <div className="cooking-panel-title"><div><p className="eyebrow">At hand</p><h2>Ingredients</h2></div><button className="icon-button mobile-ingredient-close" aria-label="Close ingredients" type="button" onClick={() => setIngredientsOpen(false)}><X size={18} /></button></div>
          <ul>{recipe.ingredients.map((ingredient) => {
            const checked = checkedIngredients.has(ingredient.id);
            return <li className={checked ? 'checked' : ''} key={ingredient.id}><button aria-pressed={checked} type="button" onClick={() => toggleIngredient(ingredient.id)}><span><Check size={13} /></span><strong>{formatIngredient(ingredient)}</strong></button></li>;
          })}</ul>
        </aside>

        <main className="active-step">
          <div className="step-kicker"><span>Step {step + 1}</span><span>of {total}</span></div>
          {current.section ? <p className="step-section">{current.section}</p> : null}
          <p className="step-text">{current.text}</p>

          {current.timerMinutes || seconds !== null ? (
            <section className={seconds !== null ? 'cooking-timer timer-running' : 'cooking-timer'} aria-live="polite">
              <Clock3 size={21} />
              <div><small>{seconds !== null ? 'Timer' : 'Suggested timer'}</small><strong>{seconds !== null ? timerLabel : `${current.timerMinutes} minutes`}</strong></div>
              {seconds === null ? <button type="button" onClick={startSuggestedTimer}><Play size={15} fill="currentColor" />Start</button> : <>
                <button type="button" onClick={() => setRunning((value) => !value)}>{running ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{running ? 'Pause' : 'Resume'}</button>
                <button className="reset-timer" aria-label="Reset timer" type="button" onClick={() => { setSeconds(null); setRunning(false); }}><RotateCcw size={15} /></button>
              </>}
            </section>
          ) : null}

          <div className="cooking-nav">
            <button className="button button-secondary" type="button" disabled={step === 0} onClick={() => setStep((value) => value - 1)}><ChevronLeft size={18} />Previous</button>
            {step < total - 1 ? <button className="button button-primary" type="button" onClick={() => setStep((value) => value + 1)}>Next step<ChevronRight size={18} /></button> : <button className="button button-primary finish-cooking" type="button" onClick={onFinish}><Check size={18} />Finish cooking</button>}
          </div>
        </main>
      </div>

      {!ingredientsOpen ? <button className="floating-ingredients-button" type="button" onClick={() => setIngredientsOpen(true)}><ListChecks size={17} />Ingredients</button> : null}
    </section>
  );
}

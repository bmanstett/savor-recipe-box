'use client';

import {
  Check, ChevronLeft, ChevronRight, Clock3, ExternalLink, ListChecks, Moon, Pause,
  Play, RotateCcw, Sun, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatIngredient } from '../../lib/domain';
import { sourceNameForHost } from '../../lib/recipe-source';
import type { Recipe } from '../../lib/types';

type Toast = { message: string; actionLabel?: string; action?: () => void } | null;
type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener: (type: string, listener: () => void) => void };
type WakeLockManagerLike = { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
type AudioContextCtor = typeof AudioContext;

// A kitchen timer is kept as an end time in wall-clock terms. iOS pauses
// JavaScript timers while Savor is in the background, so counting ticks would
// drift; comparing against Date.now() keeps the countdown honest.
interface KitchenTimer {
  step: number;
  endsAt: number | null;
  remainingSeconds: number;
  finished: boolean;
}

const WIDE_LAYOUT_QUERY = '(min-width: 881px)';

const PROGRESS_TTL_MS = 12 * 60 * 60 * 1000;

function progressKey(recipeId: string): string {
  return `savor:cooking-step:${recipeId}`;
}

// Progress lives in localStorage with a half-day shelf life: iOS can evict a
// suspended app entirely, and sessionStorage would vanish with it.
function readSavedStep(recipeId: string, total: number): number {
  try {
    const raw = window.localStorage.getItem(progressKey(recipeId));
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { step?: number; at?: number };
    if (!parsed.at || Date.now() - parsed.at > PROGRESS_TTL_MS) {
      window.localStorage.removeItem(progressKey(recipeId));
      return 0;
    }
    const saved = Number(parsed.step);
    return Number.isInteger(saved) && saved > 0 && saved < total ? saved : 0;
  } catch {
    return 0;
  }
}

function writeSavedStep(recipeId: string, step: number): void {
  try {
    if (step > 0) window.localStorage.setItem(progressKey(recipeId), JSON.stringify({ step, at: Date.now() }));
    else window.localStorage.removeItem(progressKey(recipeId));
  } catch { /* Storage is a convenience only. */ }
}

function sourceHost(url: string): string {
  try {
    return sourceNameForHost(new URL(url).hostname);
  } catch {
    return 'source';
  }
}

function secondsLeft(timer: KitchenTimer, now: number): number {
  if (timer.endsAt === null) return timer.remainingSeconds;
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
}

function formatClock(totalSeconds: number): string {
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function playChime(context: AudioContext | null) {
  if (!context) return;
  try {
    const start = context.currentTime;
    [0, 0.35, 0.7].forEach((offset) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.3);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.32);
    });
  } catch { /* Audio is a courtesy; the toast still announces the timer. */ }
}

export function CookingMode({ recipe, onClose, onFinish, showToast }: {
  recipe: Recipe;
  onClose: () => void;
  onFinish: () => void;
  showToast: (toast: Toast) => void;
}) {
  const total = recipe.instructions.length;
  const [step, setStep] = useState(() => readSavedStep(recipe.id, total));
  // On a phone the ingredient drawer covers the step text, so it starts closed
  // there and open as a side column on wide screens.
  const [ingredientsOpen, setIngredientsOpen] = useState(() => window.matchMedia(WIDE_LAYOUT_QUERY).matches);
  const [checkedIngredients, setCheckedIngredients] = useState<Set<string>>(new Set());
  const [timer, setTimer] = useState<KitchenTimer | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [awake, setAwake] = useState(false);
  const wakeLock = useRef<WakeLockSentinelLike | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const resumed = useRef(step > 0);
  const current = recipe.instructions[step];

  useEffect(() => {
    if (resumed.current) {
      resumed.current = false;
      showToast({ message: `Picking up at step ${step + 1}.`, actionLabel: 'Start over', action: () => setStep(0) });
    }
  }, [showToast, step]);

  useEffect(() => {
    writeSavedStep(recipe.id, step);
  }, [recipe.id, step]);

  // Tick while a timer runs, and re-check the clock whenever the app comes back.
  useEffect(() => {
    if (!timer || timer.endsAt === null) return undefined;
    const tick = () => setNow(Date.now());
    const interval = window.setInterval(tick, 500);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [timer]);

  useEffect(() => {
    if (!timer || timer.endsAt === null || timer.finished || secondsLeft(timer, now) > 0) return;
    setTimer({ ...timer, endsAt: null, remainingSeconds: 0, finished: true });
    playChime(audio.current);
    if ('vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
    showToast({ message: `Step ${timer.step + 1} timer finished.` });
  }, [now, showToast, timer]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') setStep((value) => Math.min(total - 1, value + 1));
      if (event.key === 'ArrowLeft') setStep((value) => Math.max(0, value - 1));
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose, total]);

  useEffect(() => () => {
    wakeLock.current?.release().catch(() => undefined);
    audio.current?.close().catch(() => undefined);
  }, []);

  // iOS releases the wake lock whenever Savor leaves the foreground; take it
  // back when the cook returns so the screen keeps behaving as they asked.
  useEffect(() => {
    if (!awake) return undefined;
    const reacquire = async () => {
      if (document.visibilityState !== 'visible' || wakeLock.current) return;
      const manager = (navigator as Navigator & { wakeLock?: WakeLockManagerLike }).wakeLock;
      if (!manager) return;
      try {
        const sentinel = await manager.request('screen');
        wakeLock.current = sentinel;
        sentinel.addEventListener('release', () => { wakeLock.current = null; });
      } catch {
        setAwake(false);
      }
    };
    document.addEventListener('visibilitychange', reacquire);
    return () => document.removeEventListener('visibilitychange', reacquire);
  }, [awake]);

  async function toggleAwake() {
    if (awake) {
      await wakeLock.current?.release().catch(() => undefined);
      wakeLock.current = null;
      setAwake(false);
      return;
    }
    const manager = (navigator as Navigator & { wakeLock?: WakeLockManagerLike }).wakeLock;
    if (!manager) {
      showToast({ message: 'Screen wake lock is not supported on this device.' });
      return;
    }
    try {
      const sentinel = await manager.request('screen');
      wakeLock.current = sentinel;
      sentinel.addEventListener('release', () => { wakeLock.current = null; });
      setAwake(true);
      showToast({ message: 'Screen will stay awake while you cook.' });
    } catch {
      showToast({ message: 'Savor could not keep the screen awake.' });
    }
  }

  function ensureAudio() {
    // Browsers only allow sound that starts from a tap, so the context is
    // created (and resumed) inside the Start handler and reused later.
    const Ctor = (window.AudioContext ?? (window as Window & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined;
    if (!Ctor) return;
    if (!audio.current) audio.current = new Ctor();
    if (audio.current.state === 'suspended') void audio.current.resume().catch(() => undefined);
  }

  function startSuggestedTimer() {
    if (!current?.timerMinutes) return;
    ensureAudio();
    const seconds = current.timerMinutes * 60;
    setTimer({ step, endsAt: Date.now() + seconds * 1000, remainingSeconds: seconds, finished: false });
    setNow(Date.now());
  }

  function pauseOrResume() {
    if (!timer) return;
    if (timer.endsAt === null) {
      ensureAudio();
      setTimer({ ...timer, endsAt: Date.now() + timer.remainingSeconds * 1000, finished: false });
    } else {
      setTimer({ ...timer, endsAt: null, remainingSeconds: secondsLeft(timer, Date.now()) });
    }
    setNow(Date.now());
  }

  function toggleIngredient(id: string) {
    setCheckedIngredients((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function finish() {
    writeSavedStep(recipe.id, 0);
    onFinish();
  }

  const sourceLabel = recipe.sourceURL ? sourceHost(recipe.sourceURL) : null;
  const timerBelongsHere = timer?.step === step;
  const timerSeconds = timer ? secondsLeft(timer, now) : null;
  const timerRunning = Boolean(timer && timer.endsAt !== null);
  const showTimerCard = Boolean(current?.timerMinutes) || timer !== null;

  return (
    <section className="cooking-mode" role="dialog" aria-modal="true" aria-labelledby="cooking-title">
      <header className="cooking-header">
        <div><p className="eyebrow">Cooking mode</p><h1 id="cooking-title">{recipe.title}</h1></div>
        <div className="cooking-header-actions">
          {recipe.sourceURL ? (
            <a className="cooking-tool" href={recipe.sourceURL} target="_blank" rel="noreferrer" aria-label={`Open the original recipe on ${sourceLabel}`}>
              <ExternalLink size={17} /><span>{sourceLabel}</span>
            </a>
          ) : null}
          <button className={awake ? 'cooking-tool active' : 'cooking-tool'} type="button" aria-pressed={awake} aria-label={awake ? 'Screen is staying awake' : 'Keep the screen awake'} onClick={toggleAwake}>{awake ? <Sun size={17} /> : <Moon size={17} />}<span>{awake ? 'Screen awake' : 'Keep awake'}</span></button>
          <button className="icon-button cooking-close" aria-label="Exit cooking mode" type="button" onClick={onClose}><X size={21} /></button>
        </div>
      </header>

      {!current ? (
        <div className="cooking-empty">
          <p className="eyebrow">Nothing to follow yet</p>
          <h2>This recipe has no steps.</h2>
          <p>Add instructions from the recipe's Edit screen and cooking mode will walk you through them one at a time.</p>
          <button className="button button-primary" type="button" onClick={onClose}>Back to the recipe</button>
        </div>
      ) : (
        <>
          <div className="cooking-progress" aria-label={`Step ${step + 1} of ${total}`}><span style={{ width: `${((step + 1) / total) * 100}%` }} /></div>

          <div className={ingredientsOpen ? 'cooking-layout ingredients-visible' : 'cooking-layout'}>
            {ingredientsOpen ? <button className="cooking-drawer-scrim" aria-label="Close ingredients" type="button" onClick={() => setIngredientsOpen(false)} /> : null}
            <aside className="cooking-ingredients" aria-hidden={!ingredientsOpen}>
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

              {showTimerCard ? (
                <section className={timerRunning ? 'cooking-timer timer-running' : timer?.finished ? 'cooking-timer timer-finished' : 'cooking-timer'}>
                  <Clock3 size={21} />
                  <div>
                    {/* Only the status label is announced; a per-second clock would never stop talking. */}
                    <small aria-live="polite">{timer ? (timer.finished ? `Step ${timer.step + 1} timer done` : timerBelongsHere ? 'Timer' : `Step ${timer.step + 1} timer`) : 'Suggested timer'}</small>
                    <strong>{timer && timerSeconds !== null ? formatClock(timerSeconds) : `${current.timerMinutes} minutes`}</strong>
                  </div>
                  {!timer || timer.finished || (!timerBelongsHere && current.timerMinutes) ? (
                    <button type="button" onClick={startSuggestedTimer} disabled={!current.timerMinutes}><Play size={15} fill="currentColor" />{timer && !timer.finished ? 'Start this step' : 'Start'}</button>
                  ) : (
                    <button type="button" onClick={pauseOrResume}>{timerRunning ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{timerRunning ? 'Pause' : 'Resume'}</button>
                  )}
                  {timer ? <button className="reset-timer" aria-label="Clear timer" type="button" onClick={() => setTimer(null)}><RotateCcw size={15} /></button> : null}
                </section>
              ) : null}

              <div className="cooking-nav">
                <button className="button button-secondary" type="button" disabled={step === 0} onClick={() => setStep((value) => value - 1)}><ChevronLeft size={18} />Previous</button>
                {step < total - 1 ? <button className="button button-primary" type="button" onClick={() => setStep((value) => value + 1)}>Next step<ChevronRight size={18} /></button> : <button className="button button-primary finish-cooking" type="button" onClick={finish}><Check size={18} />Finish cooking</button>}
              </div>
            </main>
          </div>

          {!ingredientsOpen ? <button className="floating-ingredients-button" type="button" onClick={() => setIngredientsOpen(true)}><ListChecks size={17} />Ingredients{checkedIngredients.size ? <b>{checkedIngredients.size}/{recipe.ingredients.length}</b> : null}</button> : null}
        </>
      )}
    </section>
  );
}

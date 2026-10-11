'use client';

import {
  Archive, Check, ChevronDown, MoreHorizontal, Plus, Printer, RefreshCw,
  RotateCcw, ShoppingBasket, Trash2, X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatQuantityWithUnit } from '../../lib/domain';
import type { GroceryCategory, GroceryItem, HouseholdPreferences } from '../../lib/types';
import { useBodyScrollLock } from './useBodyScrollLock';

const ALL_CATEGORIES: GroceryCategory[] = [
  'Produce', 'Bakery', 'Meat & Seafood', 'Dairy & Eggs', 'Pasta, Rice & Grains',
  'Canned & Jarred', 'Pantry', 'Spices & Seasonings', 'Sauces & Condiments', 'Frozen', 'Other',
];
// A row stays where it is for a moment after a tap so the list does not jump
// under the thumb and a mis-tap can be undone in place.
const SETTLE_MS = 700;
const KEEP_IN_PLACE_KEY = 'savor:grocery-keep-checked-in-place';
// Which aisles the shopper folded away survives switching tabs mid-shop
// (the view is unmounted while another tab is open).
const rememberedCollapsed = new Set<GroceryCategory>();

type Placement = 'active' | 'cart';

function displayName(item: GroceryItem): string {
  const name = item.ingredientName.trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Item';
}

function quantityLabel(item: GroceryItem): string {
  return formatQuantityWithUnit(item.quantity, item.unit);
}

function recipeSummary(item: GroceryItem): string {
  if (item.manual) return 'Added by you';
  const titles = [...new Set(item.recipeContributions.map((contribution) => contribution.recipeTitle))];
  if (!titles.length) return '';
  if (titles.length <= 2) return titles.join(' · ');
  return `${titles.slice(0, 2).join(' · ')} +${titles.length - 2}`;
}

function readKeepInPlace(): boolean {
  try { return window.localStorage.getItem(KEEP_IN_PLACE_KEY) === '1'; } catch { return false; }
}

export function GroceryView({
  items, preferences, onToggle, onAdd, onDelete, onChangeCategory, onGenerate,
  onClearChecked, onUncheckAll, onAddPantryStaple,
}: {
  items: GroceryItem[];
  preferences: HouseholdPreferences;
  onToggle: (item: GroceryItem) => Promise<void>;
  onAdd: (rawText: string) => Promise<void>;
  onDelete: (item: GroceryItem) => Promise<void>;
  onChangeCategory: (item: GroceryItem, category: GroceryCategory) => Promise<void>;
  onGenerate: () => void;
  onClearChecked: () => Promise<void>;
  onUncheckAll: () => Promise<void>;
  onAddPantryStaple: (item: GroceryItem) => Promise<void>;
}) {
  const [manualItem, setManualItem] = useState('');
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<GroceryCategory>>(() => new Set(rememberedCollapsed));

  useEffect(() => {
    rememberedCollapsed.clear();
    collapsed.forEach((category) => rememberedCollapsed.add(category));
  }, [collapsed]);
  const [cartOpen, setCartOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keepInPlace, setKeepInPlace] = useState(readKeepInPlace);
  const [settling, setSettling] = useState<Map<string, Placement>>(() => new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const settleTimers = useRef<Map<string, number>>(new Map());

  useEffect(() => () => { settleTimers.current.forEach((timer) => window.clearTimeout(timer)); }, []);

  useEffect(() => {
    try { window.localStorage.setItem(KEEP_IN_PLACE_KEY, keepInPlace ? '1' : '0'); } catch { /* convenience only */ }
  }, [keepInPlace]);

  const placementOf = useCallback((item: GroceryItem): Placement => {
    if (keepInPlace) return 'active';
    return settling.get(item.id) ?? (item.checked ? 'cart' : 'active');
  }, [keepInPlace, settling]);

  const remaining = items.filter((item) => !item.checked).length;
  const checkedCount = items.length - remaining;
  const progress = items.length ? Math.round((checkedCount / items.length) * 100) : 0;
  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;

  const categoryOrder = useMemo(
    () => [...preferences.sectionOrder, ...ALL_CATEGORIES.filter((category) => !preferences.sectionOrder.includes(category))],
    [preferences.sectionOrder],
  );
  const sections = useMemo(() => categoryOrder
    .map((category) => ({
      category,
      items: items.filter((item) => item.groceryCategory === category && placementOf(item) === 'active'),
    }))
    .filter((section) => section.items.length), [categoryOrder, items, placementOf]);
  const cartItems = useMemo(() => items.filter((item) => placementOf(item) === 'cart'), [items, placementOf]);

  async function toggle(item: GroceryItem) {
    const placement = placementOf(item);
    setSettling((current) => new Map(current).set(item.id, placement));
    const previous = settleTimers.current.get(item.id);
    if (previous) window.clearTimeout(previous);
    settleTimers.current.set(item.id, window.setTimeout(() => {
      settleTimers.current.delete(item.id);
      setSettling((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
    }, SETTLE_MS));
    await onToggle(item);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = manualItem.trim();
    if (!value) return;
    setAdding(true);
    try {
      await onAdd(value);
      setManualItem('');
      inputRef.current?.focus();
    } finally {
      setAdding(false);
    }
  }

  function toggleSection(category: GroceryCategory) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  }

  function printList() {
    const cleanup = () => document.body.classList.remove('print-grocery');
    document.body.classList.add('print-grocery');
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
  }

  const headline = !items.length
    ? 'Your list is empty'
    : remaining ? `${remaining} ${remaining === 1 ? 'item' : 'items'} to go` : 'All picked up';
  const subline = !items.length
    ? 'Build it from the meal plan or add items below.'
    : remaining
      ? `${checkedCount} of ${items.length} in the cart · ${sections.length} ${sections.length === 1 ? 'section' : 'sections'}`
      : 'Everything on the list is checked off.';

  return (
    <section className="grocery-view">
      <header className="grocery-print-heading">
        <p>Savor</p>
        <h1>Grocery list</h1>
        <span>{remaining} item{remaining === 1 ? '' : 's'} left · Printed {new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date())}</span>
      </header>

      <div className="grocery-summary">
        <div className="grocery-ring" role="img" aria-label={`${progress}% of the list is in the cart`} style={{ ['--progress' as string]: `${progress}%` }}>
          <span>{items.length ? `${progress}%` : <ShoppingBasket size={18} />}</span>
        </div>
        <div className="grocery-summary-copy">
          <h2>{headline}</h2>
          <p>{subline}</p>
        </div>
        <button className="icon-button" aria-label="List options" aria-expanded={optionsOpen} type="button" onClick={() => setOptionsOpen(true)}><MoreHorizontal size={20} /></button>
      </div>

      <form className="grocery-add" onSubmit={submit}>
        <Plus size={18} aria-hidden="true" />
        <label className="sr-only" htmlFor="manual-grocery">Add a grocery item</label>
        <input ref={inputRef} id="manual-grocery" placeholder="Add an item, like 2 lemons" enterKeyHint="done" autoComplete="off" autoCorrect="on" value={manualItem} onChange={(event) => setManualItem(event.target.value)} />
        <button className="button button-primary" type="submit" disabled={!manualItem.trim() || adding}>{adding ? '…' : 'Add'}</button>
      </form>

      {sections.length ? sections.map((section) => {
        const isCollapsed = collapsed.has(section.category);
        const left = section.items.filter((item) => !item.checked).length;
        const sectionId = `section-${section.category.replace(/\W/g, '-')}`;
        return (
          <section className={isCollapsed ? 'grocery-section collapsed' : 'grocery-section'} key={section.category} aria-labelledby={sectionId}>
            <button className="grocery-section-head" type="button" aria-expanded={!isCollapsed} aria-controls={`${sectionId}-rows`} onClick={() => toggleSection(section.category)}>
              <h3 id={sectionId}>{section.category}</h3>
              <span>{left} left</span>
              <ChevronDown size={18} aria-hidden="true" />
            </button>
            {/* Collapsed rows stay mounted (hidden by CSS) so a printed list is always complete. */}
            <ul className="grocery-rows" id={`${sectionId}-rows`} hidden={isCollapsed}>
              {section.items.map((item) => (
                <GroceryRow key={item.id} item={item} onToggle={() => toggle(item)} onMore={() => setSelectedId(item.id)} />
              ))}
            </ul>
          </section>
        );
      }) : items.length ? null : (
        <div className="useful-empty-state grocery-empty">
          <span><ShoppingBasket size={23} /></span>
          <h2>Your list starts with a plan.</h2>
          <p>Choose meals for the week and Savor combines their ingredients into one list, aisle by aisle. Pantry staples and water stay off it.</p>
          <button className="button button-primary" type="button" onClick={onGenerate}><RefreshCw size={16} />Build from meal plan</button>
        </div>
      )}

      {cartItems.length ? (
        <section className={cartOpen ? 'grocery-section grocery-cart' : 'grocery-section grocery-cart collapsed'} aria-labelledby="grocery-cart-title">
          <button className="grocery-section-head" type="button" aria-expanded={cartOpen} aria-controls="grocery-cart-rows" onClick={() => setCartOpen((value) => !value)}>
            <h3 id="grocery-cart-title">In the cart</h3>
            <span>{cartItems.length}</span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          <ul className="grocery-rows" id="grocery-cart-rows" hidden={!cartOpen}>
            {cartItems.map((item) => (
              <GroceryRow key={item.id} item={item} onToggle={() => toggle(item)} onMore={() => setSelectedId(item.id)} />
            ))}
          </ul>
          {cartOpen ? (
            <div className="grocery-cart-actions">
              <button className="button button-ghost" type="button" onClick={onUncheckAll}><RotateCcw size={15} />Put everything back</button>
              <button className="button button-secondary" type="button" onClick={onClearChecked}><Trash2 size={15} />Clear checked items</button>
            </div>
          ) : null}
        </section>
      ) : null}

      {items.length && !remaining ? (
        <div className="grocery-done">
          <p>Shopping done. Next time, refresh the list from the meal plan and it will remember what you already bought.</p>
          <button className="button button-secondary" type="button" onClick={onClearChecked}><Trash2 size={15} />Clear the list</button>
        </div>
      ) : null}

      {optionsOpen ? (
        <ActionSheet title="List options" onClose={() => setOptionsOpen(false)}>
          <button className="action-row" type="button" onClick={() => { setOptionsOpen(false); onGenerate(); }}><RefreshCw size={18} /><span><strong>Refresh from meal plan</strong><small>Rebuilds the list from this week’s meals and keeps what you already checked.</small></span></button>
          <button className="action-row" type="button" disabled={!items.length} onClick={() => { setOptionsOpen(false); printList(); }}><Printer size={18} /><span><strong>Print list</strong><small>A clean, aisle-ordered page.</small></span></button>
          <button className="action-row" type="button" aria-pressed={keepInPlace} onClick={() => setKeepInPlace((value) => !value)}><Archive size={18} /><span><strong>Keep checked items in place</strong><small>{keepInPlace ? 'On. Checked items stay in their aisle.' : 'Off. Checked items move to “In the cart”.'}</small></span><span className={keepInPlace ? 'switch-track on' : 'switch-track'} aria-hidden="true" /></button>
          {checkedCount ? <button className="action-row" type="button" onClick={() => { setOptionsOpen(false); void onUncheckAll(); }}><RotateCcw size={18} /><span><strong>Put everything back</strong><small>Unchecks all {checkedCount} items.</small></span></button> : null}
          {checkedCount ? <button className="action-row destructive" type="button" onClick={() => { setOptionsOpen(false); void onClearChecked(); }}><Trash2 size={18} /><span><strong>Clear checked items</strong><small>Removes the {checkedCount} items already in the cart.</small></span></button> : null}
        </ActionSheet>
      ) : null}

      {selected ? (
        <ActionSheet title={displayName(selected)} subtitle={quantityLabel(selected) || (selected.manual ? 'Added by you' : 'Amount as needed')} onClose={() => setSelectedId(null)}>
          <div className="item-sheet-section">
            <h4>{selected.manual ? 'Added by you' : 'Needed for'}</h4>
            {selected.recipeContributions.length ? (
              <ul className="item-sheet-recipes">
                {selected.recipeContributions.map((contribution) => <li key={`${contribution.recipeId}-${contribution.ingredientId}`}><strong>{contribution.recipeTitle}</strong><small>{contribution.rawText}</small></li>)}
              </ul>
            ) : <p className="item-sheet-note">Tap the name in the list to check it off while you shop.</p>}
          </div>
          <div className="item-sheet-section">
            <h4>Store section</h4>
            <div className="chip-row" role="radiogroup" aria-label="Store section">
              {categoryOrder.map((category) => (
                <button className={category === selected.groceryCategory ? 'filter-chip active' : 'filter-chip'} role="radio" aria-checked={category === selected.groceryCategory} type="button" key={category} onClick={() => onChangeCategory(selected, category)}>{category}</button>
              ))}
            </div>
          </div>
          <div className="item-sheet-actions">
            <button className="action-row" type="button" onClick={() => { setSelectedId(null); void onAddPantryStaple(selected); }}><Archive size={18} /><span><strong>I usually have this</strong><small>Adds it to your pantry staples and takes it off future lists.</small></span></button>
            <button className="action-row destructive" type="button" onClick={() => { setSelectedId(null); void onDelete(selected); }}><Trash2 size={18} /><span><strong>Remove from this list</strong></span></button>
          </div>
        </ActionSheet>
      ) : null}
    </section>
  );
}

function GroceryRow({ item, onToggle, onMore }: { item: GroceryItem; onToggle: () => void; onMore: () => void }) {
  const quantity = quantityLabel(item);
  const summary = recipeSummary(item);
  return (
    <li className={item.checked ? 'grocery-row checked' : 'grocery-row'}>
      <button className="grocery-row-main" type="button" aria-pressed={item.checked} aria-label={`${displayName(item)}${quantity ? `, ${quantity}` : ''}${summary ? `, for ${summary}` : ''}`} onClick={onToggle}>
        <span className="grocery-box" aria-hidden="true"><Check size={16} strokeWidth={3} /></span>
        <span className="grocery-text">
          <strong>{quantity ? <em>{quantity}</em> : null}{displayName(item)}</strong>
          {summary ? <small>{summary}</small> : null}
        </span>
      </button>
      <button className="grocery-row-more" type="button" aria-label={`Options for ${displayName(item)}`} onClick={onMore}><MoreHorizontal size={18} /></button>
    </li>
  );
}

function ActionSheet({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const sectionRef = useRef<HTMLElement>(null);
  useBodyScrollLock(true);
  useEffect(() => {
    // Focus moves into the sheet and returns to the button that opened it.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sectionRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [onClose]);
  return (
    <div className="action-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={sectionRef} className="action-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="action-sheet-grip" aria-hidden="true" />
        <header className="action-sheet-header">
          <div><h3>{title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div>
          <button className="icon-button" aria-label="Close" type="button" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="action-sheet-body">{children}</div>
      </section>
    </div>
  );
}

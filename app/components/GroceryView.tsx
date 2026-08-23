'use client';

import { Check, ChevronDown, Info, Plus, RefreshCw, RotateCcw, ShoppingBasket, Trash2 } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import { formatRational } from '../../lib/domain';
import type { GroceryCategory, GroceryItem, HouseholdPreferences } from '../../lib/types';

const ALL_CATEGORIES: GroceryCategory[] = [
  'Produce', 'Bakery', 'Meat & Seafood', 'Dairy & Eggs', 'Pasta, Rice & Grains',
  'Canned & Jarred', 'Pantry', 'Spices & Seasonings', 'Sauces & Condiments', 'Frozen', 'Other',
];

function itemQuantity(item: GroceryItem): string {
  const quantity = formatRational(item.quantity);
  const unit = item.unit === 'each' ? '' : item.unit ?? '';
  return [quantity, unit].filter(Boolean).join(' ') || 'As needed';
}

export function GroceryView({
  items, preferences, onToggle, onAdd, onDelete, onChangeCategory, onGenerate,
}: {
  items: GroceryItem[];
  preferences: HouseholdPreferences;
  onToggle: (item: GroceryItem) => Promise<void>;
  onAdd: (rawText: string) => Promise<void>;
  onDelete: (item: GroceryItem) => Promise<void>;
  onChangeCategory: (item: GroceryItem, category: GroceryCategory) => Promise<void>;
  onGenerate: () => void;
}) {
  const [manualItem, setManualItem] = useState('');
  const [hideChecked, setHideChecked] = useState(false);
  const [adding, setAdding] = useState(false);
  const remaining = items.filter((item) => !item.checked).length;
  const checked = items.length - remaining;
  const progress = items.length ? Math.round((checked / items.length) * 100) : 0;
  const visibleItems = hideChecked ? items.filter((item) => !item.checked) : items;
  const categories = useMemo(() => {
    const order = [...preferences.sectionOrder, ...ALL_CATEGORIES.filter((category) => !preferences.sectionOrder.includes(category))];
    return order.filter((category) => visibleItems.some((item) => item.groceryCategory === category));
  }, [preferences.sectionOrder, visibleItems]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = manualItem.trim();
    if (!value) return;
    setAdding(true);
    try {
      await onAdd(value);
      setManualItem('');
    } finally {
      setAdding(false);
    }
  }

  async function clearChecked() {
    await Promise.all(items.filter((item) => item.checked).map(onDelete));
  }

  return (
    <section className="grocery-view">
      <div className="shopping-summary">
        <div className="shopping-summary-main">
          <span className="basket-seal"><ShoppingBasket size={24} /></span>
          <div><p className="eyebrow">Shopping mode</p><h2>{remaining ? `${remaining} items to go` : items.length ? 'Everything is checked off.' : 'Your list is ready to be made.'}</h2><p>{items.length ? `${checked} of ${items.length} items picked up` : 'Generate a list from your meal plan or add an item below.'}</p></div>
        </div>
        <div className="grocery-summary-actions">
          <button className="button button-secondary" type="button" onClick={onGenerate}><RefreshCw size={16} />Refresh from meals</button>
          {checked ? <button className="button button-ghost" type="button" onClick={clearChecked}><Trash2 size={16} />Clear checked</button> : null}
        </div>
        <div className="large-progress" aria-label={`${progress}% complete`}><span style={{ width: `${progress}%` }} /></div>
      </div>

      <div className="grocery-body">
        <div className="grocery-list-panel">
          <form className="manual-item-form" onSubmit={submit}>
            <Plus size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="manual-grocery">Add a grocery item</label>
            <input id="manual-grocery" placeholder="Add an item — try “2 lemons”" value={manualItem} onChange={(event) => setManualItem(event.target.value)} />
            <button className="button button-primary" type="submit" disabled={!manualItem.trim() || adding}>{adding ? 'Adding…' : 'Add'}</button>
          </form>

          <div className="grocery-list-tools">
            <p>{categories.length} store sections</p>
            <label className="switch-row compact-switch"><input type="checkbox" checked={hideChecked} onChange={(event) => setHideChecked(event.target.checked)} /><span className="switch-track" /><span>Hide checked</span></label>
          </div>

          {categories.length ? categories.map((category) => {
            const sectionItems = visibleItems.filter((item) => item.groceryCategory === category);
            return (
              <section className="grocery-section" key={category} aria-labelledby={`section-${category.replace(/\W/g, '-')}`}>
                <header><h3 id={`section-${category.replace(/\W/g, '-')}`}>{category}</h3><span>{sectionItems.filter((item) => !item.checked).length}</span></header>
                <div className="grocery-rows">
                  {sectionItems.map((item) => (
                    <article className={item.checked ? 'grocery-row checked' : 'grocery-row'} key={item.id}>
                      <button className="grocery-check" aria-label={item.checked ? `Return ${item.ingredientName} to list` : `Mark ${item.ingredientName} purchased`} aria-pressed={item.checked} type="button" onClick={() => onToggle(item)}><Check size={17} /></button>
                      <button className="grocery-name" type="button" onClick={() => onToggle(item)}><strong>{item.ingredientName}</strong><small>{item.manual ? 'Added manually' : `${item.recipeContributions.length} recipe${item.recipeContributions.length === 1 ? '' : 's'}`}</small></button>
                      <span className="grocery-quantity">{itemQuantity(item)}</span>
                      <details className="grocery-details">
                        <summary aria-label={`Details for ${item.ingredientName}`}><ChevronDown size={17} /></summary>
                        <div className="provenance-popover">
                          <div className="popover-heading"><strong>Why it’s on the list</strong><button aria-label={`Delete ${item.ingredientName}`} type="button" onClick={() => onDelete(item)}><Trash2 size={14} /></button></div>
                          {item.recipeContributions.length ? (
                            <ul>{item.recipeContributions.map((contribution) => <li key={`${contribution.recipeId}-${contribution.ingredientId}`}><span>{contribution.recipeTitle}</span><small>{contribution.rawText}</small></li>)}</ul>
                          ) : <p>Added manually.</p>}
                          <label>Store section<select value={item.groceryCategory} onChange={(event) => onChangeCategory(item, event.target.value as GroceryCategory)}>{ALL_CATEGORIES.map((option) => <option value={option} key={option}>{option}</option>)}</select></label>
                        </div>
                      </details>
                    </article>
                  ))}
                </div>
              </section>
            );
          }) : (
            <div className="useful-empty-state grocery-empty">
              <span><ShoppingBasket size={23} /></span>
              <h2>Your list starts with a plan.</h2>
              <p>Choose meals and Savor will consolidate matching ingredients without guessing across incompatible units.</p>
              <button className="button button-primary" type="button" onClick={onGenerate}>Generate from meal plan</button>
            </div>
          )}
        </div>

        <aside className="grocery-insight-panel">
          <section><span className="insight-icon"><Info size={18} /></span><div><h3>Conservative by design</h3><p>Red and yellow onions stay separate. Mass never converts to volume. Tap any item to see its recipe sources.</p></div></section>
          <section><span className="insight-icon"><RotateCcw size={18} /></span><div><h3>Pantry staples</h3><p>{preferences.excludePantryStaples ? `${preferences.pantryStaples.length} usual staples are excluded automatically.` : 'Pantry staples are currently included.'}</p></div></section>
          <div className="staple-list">{preferences.pantryStaples.slice(0, 5).map((staple) => <span key={staple}>{staple}</span>)}</div>
        </aside>
      </div>
    </section>
  );
}

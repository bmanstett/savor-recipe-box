// Explicit extensions so Node's strip-types loader can import this module in the domain tests.
import { addRational } from './domain.ts';
import type { GroceryItem } from './types.ts';

// Rows for the same ingredient keep the same id across regenerations, so a
// refreshed list is an update of the row another device already checked off
// rather than a delete-and-recreate that leaves a tombstone behind.
export function groceryRowKey(item: Pick<GroceryItem, 'normalizedIngredient' | 'unit'>): string {
  return `${item.normalizedIngredient}|${item.unit ?? ''}`;
}

type Contribution = GroceryItem['recipeContributions'][number];

function sameContribution(a: Contribution, b: Contribution): boolean {
  return a.recipeId === b.recipeId && a.ingredientId === b.ingredientId;
}

function absorb(existing: GroceryItem, row: GroceryItem, now: string, pin: boolean): void {
  const newContributions = row.recipeContributions.filter((contribution) => !existing.recipeContributions.some((known) => sameContribution(known, contribution)));
  if (!newContributions.length) return;
  existing.recipeContributions = [...existing.recipeContributions, ...newContributions];
  if (existing.quantity && row.quantity && existing.unit === row.unit) {
    existing.quantity = addRational(existing.quantity, row.quantity);
  } else if (!existing.quantity && row.quantity) {
    existing.quantity = row.quantity;
    existing.unit = row.unit;
  }
  // A new need for something already in the cart must be visible again,
  // otherwise it hides in the collapsed cart group.
  if (existing.checked) {
    existing.checked = false;
    existing.purchasedAt = null;
  }
  if (pin) existing.pinned = true;
  existing.revision += 1;
  existing.dateModified = now;
}

/**
 * Folds freshly aggregated rows into the current list. A row that already
 * exists for the same ingredient and unit absorbs the new quantity and recipe
 * contributions and keeps its id; everything else is appended. Manual rows are
 * never touched, and no two rows ever share an id. With `pin`, the rows are
 * marked as added outside the meal plan so a later plan refresh keeps them.
 */
export function mergeGroceryItems(
  current: GroceryItem[],
  incoming: GroceryItem[],
  now = new Date().toISOString(),
  options: { pin?: boolean } = {},
): GroceryItem[] {
  const pin = Boolean(options.pin);
  const output = current.map((row) => ({ ...row }));
  const byKey = new Map(output.filter((row) => !row.manual).map((row) => [groceryRowKey(row), row]));
  const byId = new Map(output.map((row) => [row.id, row]));
  for (const row of incoming) {
    const existing = byKey.get(groceryRowKey(row)) ?? byId.get(row.id);
    if (existing) {
      absorb(existing, row, now, pin);
      continue;
    }
    const copy = pin ? { ...row, pinned: true } : { ...row };
    output.push(copy);
    byKey.set(groceryRowKey(copy), copy);
    byId.set(copy.id, copy);
  }
  return output;
}

function inherit(row: GroceryItem, match: GroceryItem, now: string): GroceryItem {
  // Only a purchase made for one of the recipes this row still serves carries
  // over; a new week's plan must not start half checked off.
  const stillNeeded = match.recipeContributions.some((previous) => row.recipeContributions.some((next) => next.recipeId === previous.recipeId));
  return {
    ...row,
    id: match.id,
    checked: stillNeeded && match.checked,
    purchasedAt: stillNeeded ? match.purchasedAt ?? (match.checked ? match.dateModified : null) : null,
    revision: match.revision + 1,
    dateModified: now,
  };
}

/**
 * Rebuilds the planned part of the list from a new aggregation. Plan rows are
 * replaced (keeping their ids, and their checked state when the same recipe
 * is still planned); manual rows and rows pinned from a recipe outside the
 * plan are kept, with the new rows merged into them. Each previous row is
 * claimed by at most one new row, so ids stay unique.
 */
export function replaceGeneratedItems(current: GroceryItem[], generated: GroceryItem[], now = new Date().toISOString()): GroceryItem[] {
  const kept = current.filter((row) => row.manual || row.pinned);
  const replaceable = current.filter((row) => !row.manual && !row.pinned);
  const previous = new Map(replaceable.map((row) => [groceryRowKey(row), row]));
  const byName = new Map<string, GroceryItem[]>();
  for (const row of replaceable) byName.set(row.normalizedIngredient, [...(byName.get(row.normalizedIngredient) ?? []), row]);
  const used = new Set<string>();
  const carried: GroceryItem[] = [];
  const pending: GroceryItem[] = [];
  for (const row of generated) {
    const exact = previous.get(groceryRowKey(row));
    if (exact && !used.has(exact.id)) {
      used.add(exact.id);
      carried.push(inherit(row, exact, now));
    } else {
      pending.push(row);
    }
  }
  for (const row of pending) {
    const named = (byName.get(row.normalizedIngredient) ?? []).find((candidate) => !used.has(candidate.id));
    if (named) {
      used.add(named.id);
      carried.push(inherit(row, named, now));
    } else {
      carried.push(row);
    }
  }
  return mergeGroceryItems(kept, carried, now);
}

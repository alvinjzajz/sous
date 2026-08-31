// Named floor plans in localStorage — the "Floor plans" list in the mockup's left rail,
// and the `localStorage` half SOUS_PLAN.md §6 promised (SOUS_PLAN.md §8, "Design mode's
// human half").
//
// A saved layout is a FloorPlan and nothing else. That is deliberate: `plan` is almost
// self-contained, and the ONLY reference from the rest of state into it is
// `party.tableId` / `party.joinedIds`. That single coupling is why applySavedLayout
// refuses while anyone is seated — swapping the tables out from under seated parties
// orphans every one of them.
//
// Everything here is defensive. localStorage throws outright in some privacy modes, and
// the stored JSON is editable by anyone with devtools open, so a corrupted value must
// degrade to "no saved layouts" rather than white-screen the app (§12.2).
import type { FloorPlan } from './types.ts';

const KEY = 'sous.layouts.v1';
/** Names are user-typed: a value, never schema (CLAUDE.md #7). */
const MAX_NAME = 40;
const MAX_LAYOUTS = 12;

type Store = Record<string, FloorPlan>;

/** Shape check, not a validator. Enough that a hand-edited blob cannot crash a render. */
function looksLikeAPlan(v: unknown): v is FloorPlan {
  const p = v as Partial<FloorPlan> | null;
  return (
    !!p && typeof p === 'object' &&
    !!p.bounds && typeof p.bounds.w === 'number' && typeof p.bounds.h === 'number' &&
    Array.isArray(p.tables) && Array.isArray(p.sections) &&
    Array.isArray(p.walls) && Array.isArray(p.stations) &&
    p.tables.every((t) => typeof t?.id === 'string' && typeof t?.x === 'number' && typeof t?.y === 'number')
  );
}

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, v]) => looksLikeAPlan(v)),
    ) as Store;
  } catch {
    return {}; // unavailable or unparseable: no saved layouts, not a crash
  }
}

function write(store: Store): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch {
    return false; // quota or privacy mode. The caller says so; nothing is lost in memory.
  }
}

/** Saved names, newest last-written first is not tracked, so: alphabetical and stable. */
export function listLayouts(): string[] {
  return Object.keys(read()).sort((a, b) => a.localeCompare(b));
}

export function readLayout(name: string): FloorPlan | null {
  return read()[name] ?? null;
}

export function saveLayout(name: string, plan: FloorPlan): { ok: boolean; message: string } {
  const key = name.trim().slice(0, MAX_NAME);
  if (!key) return { ok: false, message: 'A layout needs a name to be saved under.' };
  const store = read();
  if (!(key in store) && Object.keys(store).length >= MAX_LAYOUTS) {
    return { ok: false, message: `That is ${MAX_LAYOUTS} saved layouts. Delete one before saving another.` };
  }
  const existed = key in store;
  store[key] = structuredClone(plan);
  if (!write(store)) {
    return { ok: false, message: 'This browser will not store layouts — private mode, or the quota is full.' };
  }
  const { tables } = plan;
  const covers = tables.reduce((n, t) => n + t.seats, 0);
  return {
    ok: true,
    message: `${existed ? 'Updated' : 'Saved'} "${key}" — ${tables.length} tables, ${covers} covers.`,
  };
}

export function deleteLayout(name: string): { ok: boolean; message: string } {
  const store = read();
  if (!(name in store)) return { ok: false, message: `There is no saved layout called ${name}.` };
  delete store[name];
  if (!write(store)) return { ok: false, message: 'This browser will not store layouts.' };
  return { ok: true, message: `Deleted the "${name}" layout.` };
}

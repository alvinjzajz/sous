// What Sous keeps in localStorage, which is everything it keeps anywhere: there is no
// backend (SOUS_PLAN.md §6). Two things under two keys —
//
//   1. THE AUTOSAVED SESSION. The whole board, written back on every change, read on
//      boot. Reopen the page and the room, the clock and the night are where you left
//      them; Reset is the only thing that puts the seed scenario back.
//   2. NAMED FLOOR PLANS — the "Floor plans" list in the mockup's left rail.
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
import type { FloorPlan, SousState } from './types.ts';

const KEY = 'sous.layouts.v1';
/** Versioned, so a blob from an older build is ignored rather than half-restored. */
const SESSION = 'sous.session.v1';
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

/**
 * Drop the three keys that turn a parsed object into a prototype-pollution gadget.
 *
 * SOUS_PLAN.md §12.2 calls localStorage "the one that gets forgotten", and it is right:
 * the tool path is covered by `additionalProperties: false`, but this blob is editable
 * by anyone with devtools open and is deserialised on every render of the design pane.
 * A reviver returning undefined removes the key outright, before any of it is reachable.
 */
const SAFE = new Set(['__proto__', 'constructor', 'prototype']);
const scrub = (key: string, value: unknown) => (SAFE.has(key) ? undefined : value);

/** The one JSON boundary. Both keys come through here, so both get `scrub`. */
function load(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw, scrub) : null;
  } catch {
    return null; // unavailable, or somebody hand-edited it into invalid JSON
  }
}

function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota or privacy mode. Nothing is lost in memory either way.
  }
}

function read(): Store {
  const parsed = load(KEY);
  if (!parsed || typeof parsed !== 'object') return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([, v]) => looksLikeAPlan(v)),
  ) as Store;
}

const write = (store: Store) => save(KEY, store);

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

// --- The autosaved session ----------------------------------------------------

const ARRAYS = ['overrides', 'parties', 'reservations', 'waitlist', 'menu', 'tickets', 'notes'] as const;

/**
 * Shape check for a whole board, to the same standard as looksLikeAPlan: enough that a
 * stale or hand-edited blob degrades to the seed scenario instead of white-screening the
 * app. Not a validator — a session blob was written by this app's own reducer.
 *
 * The numbers are checked with Number.isFinite rather than `typeof`, because a NaN clock
 * survives JSON as null but a NaN that got in any other way would poison every countdown
 * in the model at once.
 */
function looksLikeAState(v: unknown): v is SousState {
  const s = v as Partial<SousState> | null;
  if (!s || typeof s !== 'object' || !looksLikeAPlan(s.plan)) return false;
  if (!ARRAYS.every((k) => Array.isArray(s[k]))) return false;
  const sh = s.shift;
  return (
    !!sh && typeof sh.running === 'boolean' &&
    (sh.mode === 'design' || sh.mode === 'service') &&
    [sh.clock, sh.speed, sh.seed].every((n) => Number.isFinite(n))
  );
}

/** The board this browser was last looking at, or null for "start from the seed". */
export function readSession(): SousState | null {
  const s = load(SESSION);
  return looksLikeAState(s) ? s : null;
}

/** Fire-and-forget: there is no surface to report a full quota to, and none is owed. */
export function writeSession(state: SousState): void {
  save(SESSION, state);
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION);
  } catch {
    /* nothing stored, nothing to clear */
  }
}

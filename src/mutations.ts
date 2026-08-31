// Every mutation in Sous, as plain functions (SOUS_PLAN.md §8, CLAUDE.md #5).
//
// Buttons call these. The WebMCP tools call these. There is no second implementation
// anywhere, which is why a pin refusal or a provenance stamp cannot drift between the
// two surfaces.
//
// Shape of every one of them:
//   fn(draft: SousState, args, by: Actor) -> Result
// They MUTATE the draft in place, like sim.ts's seatAt does, and return a sentence.
// A refusal is a VALUE (`{ok:false}`), not a throw: the UI needs it to disable a button
// and the tool wrapper turns it into `throw new Error(message)` for the model (§3).
// Nothing here clones, snapshots or touches React — store.ts owns all three.
//
// PINS BLOCK EVERYONE. A pinned table or party refuses mutation whoever asks; only a
// human may unpin (§5). The human owning the pin is the point — "what you move, you own".
import {
  computeConflicts, conflictKey, errorsOnly, floorTop, gap, rawConflicts, tableBox,
} from './conflicts.ts';
import { floorPlan } from './seed.ts';
import { RUNNER_MIN, fireTicket, freeTables, quoteWait, seatAt, tablesHeld } from './sim.ts';
import { MIN_AISLE_CELLS, fmtClock } from './types.ts';
import type {
  Conflict, FloorPlan, MenuCourse, MenuItem, Party, Reservation, SousState, Table, Ticket,
  TicketItem,
} from './types.ts';

export type Actor = 'human' | 'agent';
export type Result<T = undefined> =
  | { ok: true; message: string; data?: T }
  | { ok: false; message: string };

const ok = <T>(message: string, data?: T): Result<T> => ({ ok: true, message, data });
const no = (message: string): Result<never> => ({ ok: false, message });

/** Aisle minimum rounded up to whole cells — what layout code actually spaces by. */
const AISLE = Math.ceil(MIN_AISLE_CELLS);
/** Wall thickness; the usable room is inset by this much (matches conflicts.wallBox). */
const WALL = 2;
/** Two tables can be pushed together if they are no further apart than this. */
const JOIN_MAX = 2 * MIN_AISLE_CELLS;
/** Caps on agent-supplied order lines — schema validation is not enough (§12.1). */
const MAX_LINES = 12;
const MAX_QTY = 12;
/** Table footprint bounds, in cells. Shared by updateTable and the reshape buttons. */
const MIN_SIDE = 4;
const MAX_SIDE = 60;
/** Free text a tool may write into state. */
const MAX_TEXT = 240;

const list = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;

// --- Undo snapshots ----------------------------------------------------------
// Here rather than in store.ts because these are the mutation path's rules, not
// React's, and a check script has to be able to run them (§2, rules 2 and 3).

/** Domain state only. NEVER the clock — undo rewinds the board, not time. */
export type Snapshot = Omit<SousState, 'shift'>;

export const snapshot = (s: SousState): Snapshot => {
  const { shift: _clock, ...rest } = s;
  return structuredClone(rest);
};

/**
 * Put a snapshot back under the clock that is running NOW. Every timestamp in the
 * model is absolute, so the restored parties' timers recompute against the current
 * minute instead of resurrecting a stale countdown.
 */
export const restore = (snap: Snapshot, now: SousState): SousState => ({
  ...structuredClone(snap),
  shift: now.shift,
});

// --- Shared guards -----------------------------------------------------------

const liveParties = (s: SousState) => s.parties.filter((p) => p.course !== 'departed');

/**
 * Furniture moves before service, not during it (SOUS_PLAN.md §8, "Design mode's human
 * half"). One guard, four mutations, so a button and a tool refuse with the same
 * sentence. `assignSection` is deliberately NOT gated: `server-push` is a service-scope
 * conflict and re-sectioning is the only mutation that clears it.
 */
const designOnly = (s: SousState) =>
  s.shift.mode === 'service'
    ? no('The shift is in service. Switch to design mode before moving furniture.')
    : null;

/** The party sitting at a table, counting tables pushed together. */
const partyAt = (s: SousState, tableId: string) => tablesHeld(s).get(tableId) ?? null;

/**
 * Resolve a table from whatever handle the caller had — an id or a name, because a tool
 * is told both by get_floorplan and a person only ever says the name.
 *
 * IDS ARE TRIED FIRST, and the order matters. A rename leaves the old id behind, so
 * after T1 becomes "Window" and another table takes the name "T1" the string is
 * genuinely ambiguous. Ids are unique by construction and names are user-typed, so the
 * id wins and the resolution stays deterministic.
 */
function findTable(s: SousState, id: string): Table | null {
  const key = id.trim().toLowerCase();
  return s.plan.tables.find((t) => t.id.toLowerCase() === key)
    ?? s.plan.tables.find((t) => t.name.toLowerCase() === key)
    ?? null;
}

/**
 * Name uniqueness is about NAMES ONLY, which is why this is not findTable.
 *
 * Every seeded table has id === name, so asking findTable "is this name taken?" matched
 * the renamed table's leftover ID and kept its old name reserved for ever — you could
 * rename T1 to "Window" and still never call anything else T1. It also broke automatic
 * naming, since nextTableName would correctly offer a freed name that this then refused.
 */
const findByName = (s: SousState, name: string): Table | null => {
  const key = name.trim().toLowerCase();
  return s.plan.tables.find((t) => t.name.toLowerCase() === key) ?? null;
};

/** Resolve "the party" from whichever handle the caller had — party id or table. */
function findParty(s: SousState, a: { partyId?: string; tableId?: string }): Party | null {
  if (a.partyId) {
    const p = s.parties.find((x) => x.id === a.partyId);
    if (p && p.course !== 'departed') return p;
    return null;
  }
  const t = a.tableId ? findTable(s, a.tableId) : null;
  return t ? partyAt(s, t.id) : null;
}

/**
 * PLACEMENT REPORTS, IT DOES NOT REFUSE.
 *
 * A layout edit puts a table wherever it was asked to go, and any overlap or closed
 * aisle comes back as a sentence on the RESULT and as a live mark on the floor — which
 * is SOUS_PLAN.md §4's stated mitigation ("run computeConflicts after every layout
 * mutation and return its findings in the tool result so the agent self-corrects")
 * rather than the extra belt of refusing outright. A person dragging a table across the
 * room must never be fought by the grid, and the agent still gets told what it broke.
 *
 * The gate moved to `setPin`: you may put a table anywhere, but you may only PIN one
 * that is actually clear. Pinning is the commitment, so pinning is where legality is
 * enforced.
 */
function placementNote(s: SousState, table: Table): string {
  const bad = placementErrors(s, table);
  if (!bad.length) return '';
  const spot = findSpot(s, table, { x: table.x, y: table.y });
  const hint = spot && (spot.x !== table.x || spot.y !== table.y)
    ? ` Nearest clear spot is x ${spot.x}, y ${spot.y}.`
    : '';
  return ` ${bad[0].message}${hint}`;
}

/**
 * Errors this table's placement introduces, and nothing else. The same engine, filtered
 * by difference (CLAUDE.md #6) — geometry is never re-implemented here.
 */
function placementErrors(s: SousState, table: Table): Conflict[] {
  const others = s.plan.tables.filter((t) => t.id !== table.id);
  const base = new Set(
    errorsOnly(computeConflicts({ ...s, plan: { ...s.plan, tables: others } }, 'design')).map(conflictKey),
  );
  // PUT IT BACK AT ITS OWN INDEX, not on the end. The pairwise rules compare each table
  // only with the ones after it, so appending made an overlap come out as "T2 overlaps
  // T1" where the board itself says "T1 overlaps T2" — the same situation under a
  // different conflict key. That broke overrides (an accepted conflict would not match
  // the one the pin gate checks) and made the refusal name the wrong table first.
  const at = s.plan.tables.findIndex((t) => t.id === table.id);
  const tables = at < 0 ? [...others, table] : [...others.slice(0, at), table, ...others.slice(at)];
  const withIt = { ...s, plan: { ...s.plan, tables } };
  return errorsOnly(computeConflicts(withIt, 'design')).filter((c) => !base.has(conflictKey(c)));
}

/**
 * Nearest legal grid position for a table, searched outward from `near`.
 *
 * This is §4's answer to "models are mediocre at raw x/y": the agent names an anchor
 * or a rough point and gets a spot that already passes the conflict engine.
 *
 * ponytail: brute-force scan of every grid cell, re-running computeConflicts per
 * candidate — O(cells x tables x obstacles), a few hundred thousand comparisons on a
 * 16-table room. Ceiling is a room with hundreds of tables; the upgrade is to test the
 * candidate against a swept-box list instead of the whole engine.
 */
export function findSpot(
  s: SousState,
  proto: Table,
  near: { x: number; y: number },
): { x: number; y: number } | null {
  const { bounds, gridSize } = s.plan;
  const others = s.plan.tables.filter((t) => t.id !== proto.id);
  const base = new Set(
    errorsOnly(computeConflicts({ ...s, plan: { ...s.plan, tables: others } }, 'design')).map(conflictKey),
  );
  const step = (v: number) => Math.ceil(v / gridSize) * gridSize;
  const top = floorTop(s.plan);
  const cands: { x: number; y: number; d: number }[] = [];
  for (let y = step(top + proto.h / 2); y + proto.h / 2 <= bounds.h - WALL; y += gridSize) {
    for (let x = step(WALL + proto.w / 2); x + proto.w / 2 <= bounds.w - WALL; x += gridSize) {
      cands.push({ x, y, d: (x - near.x) ** 2 + (y - near.y) ** 2 });
    }
  }
  cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  for (const c of cands) {
    const trial = { ...proto, x: c.x, y: c.y };
    const withIt = { ...s, plan: { ...s.plan, tables: [...others, trial] } };
    const bad = errorsOnly(computeConflicts(withIt, 'design')).some((x) => !base.has(conflictKey(x)));
    if (!bad) return { x: c.x, y: c.y };
  }
  return null;
}

// --- Table geometry ----------------------------------------------------------

/** Default footprint for a seat count, matching the seed's proportions. */
export function protoFor(seats: number): { w: number; h: number; shape: Table['shape'] } {
  if (seats <= 4) return { w: seats <= 2 ? 8 : 10, h: seats <= 2 ? 8 : 10, shape: 'round' };
  return { w: 8 + 4 * Math.ceil(seats / 2), h: 10, shape: 'rect' };
}

export type Reshape = 'rotate' | 'grow' | 'shrink' | 'widen';

/**
 * The four reshape buttons (§4), expressed as arguments to updateTable — so they inherit
 * pin refusal, the aisle rules and the "nearest clear spot" hint for free rather than
 * growing a second geometry path. Duplicate and Delete are addTable and removeTable
 * directly and need nothing here.
 *
 * SEATS ARE NOT DERIVED FROM SIZE. These four change the footprint only; how many covers
 * a table takes is a judgement the person makes with the seat stepper beside them (the
 * mockup's "SELECTED TABLE / Seats - 4 +"). A six-top pushed into a corner is still a
 * six-top, and guessing otherwise silently rewrote the room's capacity.
 *
 * Returns null when the button should be DISABLED rather than shipped dead: rotate is a
 * no-op on a round table (w === h by invariant), and MIN/MAX are the size ends.
 */
export function reshape(t: Table, kind: Reshape, grid: number) {
  const fits = (w: number, h: number) => w >= MIN_SIDE && h >= MIN_SIDE && w <= MAX_SIDE && h <= MAX_SIDE;
  switch (kind) {
    case 'rotate':
      return t.w === t.h ? null : { tableId: t.id, w: t.h, h: t.w };
    case 'grow':
    case 'shrink': {
      const step = kind === 'grow' ? grid : -grid;
      // A round table is square by invariant, so it grows on both axes together.
      const [w, h] = [t.w + step, t.shape === 'round' ? t.w + step : t.h + step];
      return fits(w, h) ? { tableId: t.id, w, h } : null;
    }
    case 'widen': {
      // updateTable forces h === w on a round table, so widening one would just grow it.
      // Widening is the move that turns a round two-top into a rect; say so explicitly.
      const w = t.w + grid;
      return fits(w, t.h) ? { tableId: t.id, w, shape: 'rect' as const } : null;
    }
  }
}

/** Semantic anchors, so a model never has to guess a coordinate (§4). */
export const ANCHORS = [
  'north-wall', 'south-wall', 'east-wall', 'west-wall', 'by-window',
  'near-pass', 'centre', 'corner-nw', 'corner-ne', 'corner-sw', 'corner-se',
] as const;
export type Anchor = (typeof ANCHORS)[number];

function anchorPoint(s: SousState, anchor: Anchor): { x: number; y: number } {
  const { bounds } = s.plan;
  const top = floorTop(s.plan) + AISLE;
  const bottom = bounds.h - WALL - AISLE;
  const left = WALL + AISLE;
  const right = bounds.w - WALL - AISLE;
  const mid = { x: Math.round(bounds.w / 2), y: Math.round((top + bottom) / 2) };
  const pass = s.plan.stations.find((st) => st.type === 'pass');
  switch (anchor) {
    case 'north-wall': return { x: mid.x, y: top };
    case 'south-wall': return { x: mid.x, y: bottom };
    case 'east-wall': return { x: right, y: mid.y };
    case 'west-wall': return { x: left, y: mid.y };
    // Both long walls are windows in this room; the east one is the view.
    case 'by-window': return { x: right, y: mid.y };
    case 'near-pass': return { x: pass ? pass.x : mid.x, y: top };
    case 'corner-nw': return { x: left, y: top };
    case 'corner-ne': return { x: right, y: top };
    case 'corner-sw': return { x: left, y: bottom };
    case 'corner-se': return { x: right, y: bottom };
    default: return mid;
  }
}

const adjacent = (a: Table, b: Table) => gap(tableBox(a), tableBox(b)) <= JOIN_MAX;

/** Section whose tables sit nearest this point — where a new table belongs. */
function nearestSection(s: SousState, at: { x: number; y: number }): string {
  let best = s.plan.sections[0]?.id ?? '';
  let bestD = Infinity;
  for (const sec of s.plan.sections) {
    for (const id of sec.tableIds) {
      const t = s.plan.tables.find((x) => x.id === id);
      if (!t) continue;
      const d = (t.x - at.x) ** 2 + (t.y - at.y) ** 2;
      if (d < bestD) [best, bestD] = [sec.id, d];
    }
  }
  return best;
}

function putInSection(s: SousState, tableId: string, sectionId: string): void {
  for (const sec of s.plan.sections) {
    const i = sec.tableIds.indexOf(tableId);
    if (i >= 0 && sec.id !== sectionId) sec.tableIds.splice(i, 1);
  }
  const target = s.plan.sections.find((sec) => sec.id === sectionId);
  if (target && !target.tableIds.includes(tableId)) target.tableIds.push(tableId);
  const t = s.plan.tables.find((x) => x.id === tableId);
  if (t) t.sectionId = sectionId;
}

const findSection = (s: SousState, id: string) =>
  s.plan.sections.find(
    (x) => x.id === id || x.name.toLowerCase() === id.trim().toLowerCase(),
  ) ?? null;

const nextTableName = (s: SousState) => {
  const used = new Set(s.plan.tables.map((t) => t.name.toUpperCase()));
  for (let n = 1; ; n++) if (!used.has(`T${n}`)) return `T${n}`;
};

// --- Design ------------------------------------------------------------------

export function addTable(
  s: SousState,
  a: { seats: number; name?: string; x?: number; y?: number; near?: { x: number; y: number }; anchor?: Anchor; sectionId?: string; shape?: Table['shape'] },
  by: Actor,
): Result<Table> {
  const shut = designOnly(s);
  if (shut) return shut;
  const seats = Math.round(a.seats);
  if (!Number.isFinite(seats) || seats < 1 || seats > 12) {
    return no(`A table seats 1 to 12; ${a.seats} is not a table.`);
  }
  const proto = protoFor(seats);
  const shape = a.shape ?? proto.shape;
  const size = shape === 'round' ? { w: proto.w, h: proto.w } : { w: proto.w, h: proto.h };
  const name = (a.name ?? nextTableName(s)).trim().slice(0, 24);
  if (findByName(s, name)) return no(`There is already a table called ${name}.`);

  const placed = a.x !== undefined && a.y !== undefined;
  // `x`/`y` is an explicit placement and is REFUSED if it does not fit (§4's coordinate
  // mitigation). `near` is a hint: it goes straight to findSpot, which is what Duplicate
  // wants — never place by raw offset, a 1-cell gap is 125mm against a 915mm minimum.
  const near = placed
    ? { x: Math.round(a.x as number), y: Math.round(a.y as number) }
    : a.near
      ? { x: Math.round(a.near.x), y: Math.round(a.near.y) }
      : anchorPoint(s, a.anchor ?? 'centre');
  const table: Table = {
    id: `t-${Date.now().toString(36)}-${s.plan.tables.length}`,
    name, x: near.x, y: near.y, ...size, shape, seats,
    sectionId: a.sectionId ?? '',
    pinned: false,
    provenance: by,
  };

  // Without an explicit coordinate, still ask findSpot for somewhere legal — that is
  // what anchors and Duplicate are for. If nothing is clear, place it anyway and say so.
  if (!placed) {
    const spot = findSpot(s, table, near);
    if (spot) [table.x, table.y] = [spot.x, spot.y];
  }

  const sec = a.sectionId ? findSection(s, a.sectionId) : findSection(s, nearestSection(s, table));
  if (!sec) return no(`There is no section ${a.sectionId}. Sections are ${list(s.plan.sections.map((x) => x.name))}.`);
  s.plan.tables.push(table);
  putInSection(s, table.id, sec.id);
  return ok(
    `Placed ${table.name}, ${seats} seats, in ${sec?.name ?? 'no'} section at x ${table.x}, y ${table.y}.${placementNote(s, table)}`,
    table,
  );
}

export function updateTable(
  s: SousState,
  a: { tableId: string; name?: string; x?: number; y?: number; w?: number; h?: number; seats?: number; shape?: Table['shape']; sectionId?: string },
  by: Actor,
): Result<Table> {
  const shut = designOnly(s);
  if (shut) return shut;
  const t = findTable(s, a.tableId);
  if (!t) return no(`There is no table ${a.tableId}.`);
  if (t.pinned) return no(`${t.name} is pinned. Unpin it first, or leave it where it is.`);
  const sitting = partyAt(s, t.id);
  if (sitting?.pinned) return no(`${sitting.name} is pinned at ${t.name}. Leave their table alone.`);
  const section = a.sectionId === undefined ? null : findSection(s, a.sectionId);
  if (a.sectionId !== undefined && !section) {
    return no(`There is no section ${a.sectionId}. Sections are ${list(s.plan.sections.map((x) => x.name))}.`);
  }

  const next: Table = { ...t };
  if (a.name !== undefined) {
    const name = a.name.trim().slice(0, 24);
    if (!name) return no('A table needs a name.');
    const clash = findByName(s, name);
    if (clash && clash.id !== t.id) return no(`There is already a table called ${name}.`);
    next.name = name;
  }
  if (a.seats !== undefined) {
    const seats = Math.round(a.seats);
    if (seats < 1 || seats > 12) return no(`A table seats 1 to 12; ${a.seats} is not a table.`);
    if (sitting && seats < sitting.size) {
      return no(`${sitting.name} is ${sitting.size} at ${t.name}; it cannot drop to ${seats} seats while they are sitting there.`);
    }
    next.seats = seats;
  }
  if (a.shape !== undefined) next.shape = a.shape;
  if (a.w !== undefined) next.w = Math.round(a.w);
  if (a.h !== undefined) next.h = Math.round(a.h);
  if (next.shape === 'round') next.h = next.w; // round tables are square by invariant
  if (next.w < MIN_SIDE || next.h < MIN_SIDE || next.w > MAX_SIDE || next.h > MAX_SIDE) {
    return no(`${next.w} x ${next.h} cells is not a table; ${MIN_SIDE} to ${MAX_SIDE} cells a side.`);
  }
  if (a.x !== undefined) next.x = Math.round(a.x);
  if (a.y !== undefined) next.y = Math.round(a.y);

  Object.assign(t, next, { provenance: by });
  if (section) putInSection(s, t.id, section.id);
  const sec = s.plan.sections.find((x) => x.tableIds.includes(t.id));
  return ok(
    `${t.name}: ${t.seats} seats, ${t.w} x ${t.h} cells at x ${t.x}, y ${t.y}, ${sec?.name ?? 'no'} section.${placementNote(s, t)}`,
    t,
  );
}

export function removeTable(s: SousState, a: { tableId: string }, _by: Actor): Result<Table> {
  const shut = designOnly(s);
  if (shut) return shut;
  const t = findTable(s, a.tableId);
  if (!t) return no(`There is no table ${a.tableId}.`);
  if (t.pinned) return no(`${t.name} is pinned. Unpin it first if you really mean to take it out.`);
  const party = partyAt(s, t.id);
  if (party) return no(`${party.name} is sitting at ${t.name}. Clear the table first.`);
  s.plan.tables = s.plan.tables.filter((x) => x.id !== t.id);
  for (const sec of s.plan.sections) sec.tableIds = sec.tableIds.filter((id) => id !== t.id);
  return ok(`Took ${t.name} off the floor.`, t);
}

export function assignSection(
  s: SousState,
  a: { tableIds: string[]; sectionId: string },
  _by: Actor,
): Result<{ moved: string[] }> {
  const sec = findSection(s, a.sectionId);
  if (!sec) return no(`There is no section ${a.sectionId}. Sections are ${list(s.plan.sections.map((x) => x.name))}.`);
  if (!a.tableIds?.length) return no('Name at least one table to move.');
  const tables: Table[] = [];
  for (const id of a.tableIds) {
    const t = findTable(s, id);
    if (!t) return no(`There is no table ${id}.`);
    if (t.pinned) return no(`${t.name} is pinned. Unpin it first, or leave it in ${s.plan.sections.find((x) => x.tableIds.includes(t.id))?.name ?? 'its section'}.`);
    tables.push(t);
  }
  for (const t of tables) putInSection(s, t.id, sec.id);
  return ok(
    `Moved ${list(tables.map((t) => t.name))} into ${sec.name} (${sec.serverName}).`,
    { moved: tables.map((t) => t.id) },
  );
}

/** Repeating seat counts each packed template lays down, left to right. */
const PATTERNS: Record<string, number[]> = { banquet: [8, 8, 8], communal: [10, 2, 2, 10] };

/** Fill the dining floor row by row on the aisle pitch. Legal by construction. */
function packRoom(s: SousState, pattern: number[], covers: number): Omit<Table, 'id' | 'name' | 'sectionId' | 'pinned' | 'provenance'>[] {
  const { bounds } = s.plan;
  const out: Omit<Table, 'id' | 'name' | 'sectionId' | 'pinned' | 'provenance'>[] = [];
  let total = 0;
  let k = 0;
  for (let y = floorTop(s.plan) + AISLE; total < covers; ) {
    const rowH = 10;
    if (y + rowH > bounds.h - WALL - AISLE) break;
    let x = WALL + AISLE;
    let placed = 0;
    while (total < covers) {
      const seats = pattern[k % pattern.length];
      const proto = protoFor(seats);
      if (x + proto.w > bounds.w - WALL - AISLE) break;
      out.push({ x: x + proto.w / 2, y: y + rowH / 2, w: proto.w, h: proto.h, shape: proto.shape, seats });
      x += proto.w + AISLE;
      total += seats;
      k += 1;
      placed += 1;
    }
    if (!placed) break;
    y += rowH + AISLE;
  }
  return out;
}

export function applyLayoutTemplate(
  s: SousState,
  a: { template: 'bistro' | 'banquet' | 'communal'; covers?: number },
  by: Actor,
): Result<{ tables: number; covers: number }> {
  const shut = designOnly(s);
  if (shut) return shut;
  if (liveParties(s).length) return no('There are people at tables. Lay the room out before service, not during it.');
  const covers = Math.round(a.covers ?? 60);
  if (covers < 8 || covers > 200) return no(`Ask for 8 to 200 covers; ${a.covers} is not a dining room.`);
  if (a.template !== 'bistro' && !PATTERNS[a.template]) {
    return no(`Templates are bistro, banquet or communal; ${a.template} is not one.`);
  }

  const kept = s.plan.tables.filter((t) => t.pinned);
  const pinnedNames = kept.map((t) => t.name);
  s.plan.tables = [...kept];
  for (const sec of s.plan.sections) sec.tableIds = sec.tableIds.filter((id) => kept.some((t) => t.id === id));

  // The bistro template IS the seeded room (§7) — same 16 tables, dropped from the tail
  // to hit a smaller cover count. Packed templates are generated on the aisle pitch.
  const budget = covers - kept.reduce((n, t) => n + t.seats, 0);
  const rows: { x: number; y: number; w: number; h: number; shape: Table['shape']; seats: number; sectionId?: string; name?: string }[] = [];
  if (a.template === 'bistro') {
    let total = 0;
    for (const t of floorPlan.tables) {
      if (total + t.seats > budget) continue;
      rows.push({ x: t.x, y: t.y, w: t.w, h: t.h, shape: t.shape, seats: t.seats, sectionId: t.sectionId, name: t.name });
      total += t.seats;
    }
  } else {
    rows.push(...packRoom(s, PATTERNS[a.template], budget));
  }

  const bands = s.plan.sections.length;
  let seated = 0;
  for (const row of rows) {
    const name = row.name && !findByName(s, row.name) ? row.name : nextTableName(s);
    const band = Math.min(bands - 1, Math.floor((row.x / s.plan.bounds.w) * bands));
    const table: Table = {
      id: `t-${a.template}-${s.plan.tables.length}`,
      name, x: row.x, y: row.y, w: row.w, h: row.h, shape: row.shape, seats: row.seats,
      sectionId: row.sectionId ?? s.plan.sections[band]?.id ?? '',
      pinned: false,
      provenance: by,
    };
    // A row landing on a pinned table is still skipped: the pin is the one thing a
    // template may not walk over (CLAUDE.md #9). Everything else is placed and reported.
    if (placementErrors({ ...s, plan: { ...s.plan, tables: kept } }, table).length) continue;
    s.plan.tables.push(table);
    putInSection(s, table.id, table.sectionId);
    seated += table.seats;
  }

  const total = s.plan.tables.reduce((n, t) => n + t.seats, 0);
  const held = pinnedNames.length ? ` Left ${list(pinnedNames)} where you pinned ${pinnedNames.length > 1 ? 'them' : 'it'}.` : '';
  return ok(
    `Laid out a ${a.template} room: ${s.plan.tables.length} tables, ${total} covers.${held}`,
    { tables: s.plan.tables.length, covers: total },
  );
}

/**
 * Put a saved floor plan back on the floor (SOUS_PLAN.md §8, "Design mode's human half").
 *
 * Goes through the mutation path like everything else, so loading a layout undoes. Walls,
 * stations and bounds are taken wholesale because nothing on the tool surface can change
 * them; only tables and sections can differ between two saved rooms.
 */
export function applySavedLayout(
  s: SousState,
  a: { name: string; plan: FloorPlan },
  _by: Actor,
): Result<{ tables: number; covers: number }> {
  const shut = designOnly(s);
  if (shut) return shut;
  // The one coupling out of `plan` is party.tableId, so this is not optional.
  if (liveParties(s).length) {
    return no('There are people at tables. Load a different room before service, not during it.');
  }

  // A pin is the one thing a load may not walk over (CLAUDE.md #9). Keep pinned tables
  // and drop them back on top, so "don't move this one" survives a whole-room swap.
  const kept = s.plan.tables.filter((t) => t.pinned);
  const keptNames = kept.map((t) => t.name);
  const saved = structuredClone(a.plan);

  s.plan.tables = [...saved.tables.filter((t) => !kept.some((k) => k.name === t.name)), ...kept];
  s.plan.sections = saved.sections.map((sec) => ({
    ...sec,
    tableIds: sec.tableIds.filter((id) => s.plan.tables.some((t) => t.id === id)),
  }));
  for (const t of kept) if (!s.plan.sections.some((x) => x.tableIds.includes(t.id))) {
    putInSection(s, t.id, nearestSection(s, t));
  }

  const covers = s.plan.tables.reduce((n, t) => n + t.seats, 0);
  const held = keptNames.length
    ? ` Left ${list(keptNames)} where you pinned ${keptNames.length > 1 ? 'them' : 'it'}.`
    : '';
  return ok(
    `Loaded "${a.name}": ${s.plan.tables.length} tables, ${covers} covers.${held}`,
    { tables: s.plan.tables.length, covers },
  );
}

// --- Floor -------------------------------------------------------------------

export function addToWaitlist(
  s: SousState,
  a: { name: string; size: number },
  _by: Actor,
): Result<{ id: string; quotedMinutes: number }> {
  const name = (a.name ?? '').trim().slice(0, 40);
  const size = Math.round(a.size);
  if (!name) return no('A walk-in needs a name for the list.');
  if (!Number.isFinite(size) || size < 1 || size > 20) return no(`A party is 1 to 20 people; ${a.size} is not.`);
  if (s.waitlist.length >= 12) return no('The waitlist is full at 12 parties. Seat someone before adding another.');
  const quotedMinutes = quoteWait(s, size);
  const id = `w-${s.shift.clock}-${s.waitlist.length}`;
  s.waitlist.push({ id, name, size, addedAt: s.shift.clock, quotedMinutes });
  return ok(
    quotedMinutes === 0
      ? `${name}, ${size}, added to the list — a table is free now.`
      : `${name}, ${size}, added to the list, quoted ${quotedMinutes} minutes.`,
    { id, quotedMinutes },
  );
}

/** Shared by seat_party and move_party: are these tables a legal home for this party? */
function checkTables(
  s: SousState,
  tableIds: string[],
  size: number,
  moving: Party | null,
): { ok: true; tables: Table[] } | { ok: false; message: string } {
  if (!tableIds?.length) return { ok: false, message: 'Name at least one table.' };
  if (tableIds.length > 3) return { ok: false, message: 'Three tables is the most this room pushes together.' };
  const tables: Table[] = [];
  for (const id of tableIds) {
    const t = findTable(s, id);
    if (!t) return { ok: false, message: `There is no table ${id}.` };
    const sitting = partyAt(s, t.id);
    if (sitting && sitting.id !== moving?.id) {
      return { ok: false, message: `${sitting.name} is already at ${t.name}. Try another table, or clear it first.` };
    }
    if (tables.some((x) => x.id === t.id)) return { ok: false, message: `${t.name} is named twice.` };
    tables.push(t);
  }
  for (let i = 1; i < tables.length; i++) {
    if (!tables.some((other, j) => j !== i && adjacent(tables[i], other))) {
      return { ok: false, message: `${tables[i].name} is nowhere near the others; tables have to touch to be pushed together.` };
    }
  }
  const seats = tables.reduce((n, t) => n + t.seats, 0);
  if (seats < size) {
    const names = tables.map((t) => t.name).join('+');
    return { ok: false, message: `${names} seats ${seats}; the party is ${size}. ${suggestSeating(s, size)}` };
  }
  return { ok: true, tables };
}

function suggestSeating(s: SousState, size: number): string {
  const singles = freeTables(s).filter((t) => t.seats >= size);
  if (singles.length) return `Try ${list(singles.slice(0, 3).map((t) => t.name))}.`;
  const free = freeTables(s);
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (free[i].seats + free[j].seats >= size && adjacent(free[i], free[j])) {
        return `Try combining ${free[i].name}+${free[j].name}.`;
      }
    }
  }
  return 'Nothing free fits them — quote_wait and add_to_waitlist.';
}

/**
 * Hold a table for a booking, or let it go again (pass no `tableId` to unassign).
 *
 * ASSIGNING IS NOT SEATING. The party is not in the room yet and the table may still
 * have somebody at it, so this deliberately does not care whether it is free — a 6:00
 * two-top and an 8:30 four-top are the same table twice in one night. What it does buy
 * is a promise: once a booking is assigned, `seatWaiting` will only ever sit them there,
 * so the house cannot quietly undo the host's plan.
 */
export function assignReservation(
  s: SousState,
  a: { reservationId: string; tableId?: string },
  _by: Actor,
): Result<Reservation> {
  const key = a.reservationId.trim().toLowerCase();
  const r = s.reservations.find(
    (x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key,
  );
  if (!r) return no(`There is no booking ${a.reservationId}.`);
  if (r.status === 'seated') return no(`${r.name} is already sitting down.`);
  if (r.status === 'no-show') return no(`${r.name} was marked a no-show.`);

  if (!a.tableId) {
    if (!r.tableId) return no(`${r.name} is not held for any table.`);
    const was = findTable(s, r.tableId)?.name ?? r.tableId;
    delete r.tableId;
    return ok(`${r.name} is off ${was}; any table will do now.`, r);
  }

  const t = findTable(s, a.tableId);
  if (!t) return no(`There is no table ${a.tableId}.`);
  if (r.size > t.seats) {
    return no(`${t.name} seats ${t.seats}; ${r.name} is ${r.size}. Pick a bigger table, or push two together.`);
  }
  const taken = s.reservations.find(
    (x) => x.id !== r.id && x.tableId === t.id && x.status !== 'seated' && x.status !== 'no-show',
  );
  if (taken) {
    return no(`${t.name} is already held for ${taken.name} at ${fmtClock(taken.time)}. Let them go first.`);
  }

  r.tableId = t.id;
  return ok(`${t.name} is held for ${r.name}, ${r.size}, at ${fmtClock(r.time)}.`, r);
}

export function seatParty(
  s: SousState,
  a: { tableIds: string[]; reservationId?: string; waitId?: string; name?: string; size?: number },
  by: Actor,
): Result<Party> {
  const res = a.reservationId ? s.reservations.find((r) => r.id === a.reservationId) : undefined;
  const wait = a.waitId ? s.waitlist.find((w) => w.id === a.waitId) : undefined;
  if (a.reservationId && !res) return no(`There is no reservation ${a.reservationId}.`);
  if (a.waitId && !wait) return no(`There is no waitlist entry ${a.waitId}.`);
  if (res && res.status === 'seated') return no(`${res.name} is already seated.`);

  const source = res ?? wait;
  const name = (source?.name ?? a.name ?? '').trim().slice(0, 40);
  const size = Math.round(source?.size ?? a.size ?? 0);
  if (!name || !size) return no('Seat a reservation, a waitlist entry, or give a name and a size.');
  if (size < 1 || size > 20) return no(`A party is 1 to 20 people; ${a.size} is not.`);

  const check = checkTables(s, a.tableIds, size, null);
  if (!check.ok) return no(check.message);
  const [primary, ...joined] = check.tables;

  const id = source ? `p-${source.id}` : `p-${name.toLowerCase().replace(/\W+/g, '-')}-${s.shift.clock}`;
  if (s.parties.some((p) => p.id === id && p.course !== 'departed')) return no(`${name} is already at a table.`);

  const party = seatAt(s, primary, {
    id, name, size,
    notes: res?.notes ?? '',
    joinedIds: joined.map((t) => t.id),
    provenance: by,
  });
  if (res) {
    res.status = 'seated';
    delete res.tableId; // the hold is spent; where they actually sat is the party's job
  }
  if (wait) s.waitlist = s.waitlist.filter((w) => w.id !== wait.id);

  const where = check.tables.map((t) => t.name).join('+');
  const sec = s.plan.sections.find((x) => x.tableIds.includes(primary.id));
  return ok(`Seated ${name}, ${size}, at ${where} (${sec?.name ?? 'no'} section).`, party);
}

export function moveParty(
  s: SousState,
  a: { tableIds: string[]; partyId?: string; fromTableId?: string },
  _by: Actor,
): Result<Party> {
  const party = findParty(s, { partyId: a.partyId, tableId: a.fromTableId });
  if (!party) return no(`There is nobody at ${a.fromTableId ?? a.partyId}.`);
  if (party.pinned) {
    return no(`${party.name} is pinned by the host. Respond to the service note instead of moving them.`);
  }
  const from = [party.tableId, ...party.joinedIds].filter(Boolean) as string[];
  const check = checkTables(s, a.tableIds, party.size, party);
  if (!check.ok) return no(check.message);
  const [primary, ...joined] = check.tables;
  if (primary.id === party.tableId && joined.length === party.joinedIds.length && joined.every((t) => party.joinedIds.includes(t.id))) {
    return no(`${party.name} is already at ${from.join('+')}.`);
  }
  party.tableId = primary.id;
  party.joinedIds = joined.map((t) => t.id);
  const where = check.tables.map((t) => t.name).join('+');
  return ok(`Moved ${party.name}, ${party.size}, from ${from.join('+')} to ${where}.`, party);
}

export function clearTable(s: SousState, a: { tableId: string }, _by: Actor): Result<Party> {
  const t = findTable(s, a.tableId);
  if (!t) return no(`There is no table ${a.tableId}.`);
  const party = partyAt(s, t.id);
  if (!party) return no(`${t.name} is already empty.`);
  if (party.pinned) return no(`${party.name} is pinned by the host. Unpin them before clearing ${t.name}.`);
  const held = [party.tableId, ...party.joinedIds].filter(Boolean) as string[];
  party.course = 'departed';
  party.courseAt = s.shift.clock;
  party.tableId = null;
  party.joinedIds = [];
  return ok(`${party.name} has left; ${held.join('+')} ${held.length > 1 ? 'are' : 'is'} open.`, party);
}

// --- Service -----------------------------------------------------------------

/** Agent-supplied order lines are input at a trust boundary (§12.1) — validate, hard. */
function checkItems(s: SousState, course: MenuCourse, items: { menuItemId: string; qty?: number }[]):
  { ok: true; items: TicketItem[] } | { ok: false; message: string } {
  if (!items.length) return { ok: false, message: 'An order needs at least one item.' };
  if (items.length > MAX_LINES) return { ok: false, message: `${items.length} lines on one ticket is more than the kitchen takes; ${MAX_LINES} is the cap.` };
  const out: TicketItem[] = [];
  for (const line of items) {
    const m: MenuItem | undefined = s.menu.find((x) => x.id === line.menuItemId);
    if (!m) return { ok: false, message: `There is no menu item ${line.menuItemId}. Call get_menu for the ids.` };
    if (m.is86d) return { ok: false, message: `${m.name} is 86'd tonight. Pick something else for this course.` };
    if (m.course !== course) return { ok: false, message: `${m.name} is a ${m.course} dish, not a ${course} one.` };
    const qty = Math.round(line.qty ?? 1);
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) {
      return { ok: false, message: `${m.name} x${line.qty} is not an order; 1 to ${MAX_QTY} of anything.` };
    }
    const seen = out.find((i) => i.menuItemId === m.id);
    if (seen) seen.qty = Math.min(MAX_QTY, seen.qty + qty);
    else out.push({ menuItemId: m.id, qty, status: 'queued', startedAt: null });
  }
  return { ok: true, items: out };
}

export function fireCourse(
  s: SousState,
  a: { course: MenuCourse; tableId?: string; partyId?: string; items?: { menuItemId: string; qty?: number }[] },
  by: Actor,
): Result<Ticket> {
  const party = findParty(s, a);
  if (!party) return no(`There is nobody at ${a.tableId ?? a.partyId}.`);
  if (s.tickets.some((t) => t.partyId === party.id && t.course === a.course)) {
    return no(`${party.name}'s ${a.course} are already fired. Use retime_ticket or swap_ticket_item.`);
  }
  let lines: TicketItem[] | undefined;
  if (a.items) {
    const checked = checkItems(s, a.course, a.items);
    if (!checked.ok) return no(checked.message);
    lines = checked.items;
  }
  const ticket = fireTicket(s, party, a.course, by, lines);
  if (!ticket) return no(`Nobody at ${party.name} is having ${a.course}.`);
  s.tickets.push(ticket);
  const names = ticket.items.map((i) => `${i.qty}x ${s.menu.find((m) => m.id === i.menuItemId)?.name}`);
  return ok(
    `Fired ${party.name}'s ${a.course}: ${names.join(', ')}. Due ${fmtClock(ticket.dueAt)}.`,
    ticket,
  );
}

export function retimeTicket(
  s: SousState,
  a: { ticketId: string; byMinutes: number },
  _by: Actor,
): Result<Ticket> {
  const t = s.tickets.find((x) => x.id === a.ticketId);
  if (!t) return no(`There is no ticket ${a.ticketId}.`);
  const by = Math.round(a.byMinutes);
  if (!Number.isFinite(by) || by === 0 || Math.abs(by) > 120) {
    return no(`Re-time by 1 to 120 minutes either way; ${a.byMinutes} is not a change.`);
  }
  if (t.items.every((i) => i.status === 'served')) return no(`${t.id} is already on the table.`);
  const cooking = t.items.filter((i) => i.status !== 'queued').length;
  t.firedAt = Math.max(s.shift.clock, t.firedAt + by);
  t.dueAt += by;
  const note = cooking ? ` ${cooking} of ${t.items.length} items are already on the stove.` : '';
  return ok(
    `${by < 0 ? 'Pulled' : 'Pushed'} ${t.id} ${Math.abs(by)} minutes ${by < 0 ? 'forward' : 'back'}; due ${fmtClock(t.dueAt)}.${note}`,
    t,
  );
}

export function swapTicketItem(
  s: SousState,
  a: { ticketId: string; menuItemId: string; toMenuItemId?: string },
  _by: Actor,
): Result<Ticket> {
  const t = s.tickets.find((x) => x.id === a.ticketId);
  if (!t) return no(`There is no ticket ${a.ticketId}.`);
  const i = t.items.findIndex((x) => x.menuItemId === a.menuItemId);
  if (i < 0) return no(`${a.ticketId} has no ${s.menu.find((m) => m.id === a.menuItemId)?.name ?? a.menuItemId} on it.`);
  const line = t.items[i];
  const from = s.menu.find((m) => m.id === line.menuItemId);
  if (line.status !== 'queued') return no(`The ${from?.name} is already ${line.status}. Too late to change it.`);

  if (!a.toMenuItemId) {
    t.items.splice(i, 1);
    if (!t.items.length) {
      s.tickets = s.tickets.filter((x) => x.id !== t.id);
      return ok(`Dropped the ${from?.name}; that was the last line, so ${t.id} is off the board.`, t);
    }
  } else {
    const to = s.menu.find((m) => m.id === a.toMenuItemId);
    if (!to) return no(`There is no menu item ${a.toMenuItemId}. Call get_menu for the ids.`);
    if (to.is86d) return no(`${to.name} is 86'd too. Pick something that is still on.`);
    if (to.course !== t.course) return no(`${to.name} is a ${to.course} dish; ${t.id} is a ${t.course} ticket.`);
    t.items[i] = { menuItemId: to.id, qty: line.qty, status: 'queued', startedAt: null };
  }
  const menu = new Map(s.menu.map((m) => [m.id, m]));
  const cook = Math.max(0, ...t.items.map((x) => menu.get(x.menuItemId)?.cookMinutes ?? 0));
  t.dueAt = t.firedAt + cook + RUNNER_MIN;
  const to = a.toMenuItemId ? s.menu.find((m) => m.id === a.toMenuItemId) : null;
  return ok(
    `${t.id}: ${line.qty}x ${from?.name} ${to ? `swapped to ${to.name}` : 'dropped'}. Now due ${fmtClock(t.dueAt)}.`,
    t,
  );
}

export function setItem86(
  s: SousState,
  a: { menuItemId: string; is86d?: boolean },
  _by: Actor,
): Result<{ tickets: string[] }> {
  const m = s.menu.find((x) => x.id === a.menuItemId || x.name.toLowerCase() === a.menuItemId.trim().toLowerCase());
  if (!m) return no(`There is no menu item ${a.menuItemId}. Call get_menu for the ids.`);
  const is86d = a.is86d ?? true;
  if (m.is86d === is86d) return no(`${m.name} is already ${is86d ? "86'd" : 'on'}.`);
  m.is86d = is86d;
  const hit = s.tickets.filter((t) =>
    t.items.some((i) => i.menuItemId === m.id && i.status !== 'served'),
  );
  const tables = hit.map((t) => s.parties.find((p) => p.id === t.partyId)?.tableId ?? t.partyId);
  return ok(
    is86d
      ? `86'd ${m.name}.${hit.length ? ` ${hit.length} open ${hit.length > 1 ? 'tickets' : 'ticket'} still ${hit.length > 1 ? 'have' : 'has'} it: ${tables.join(', ')}. swap_ticket_item to fix them.` : ' No open tickets have it.'}`
      : `${m.name} is back on.`,
    { tickets: hit.map((t) => t.id) },
  );
}

/**
 * Accept a conflict, so the engine stops raising it (SOUS_PLAN.md §5).
 *
 * ONLY A HUMAN MAY OVERRIDE, and only a human may put one back. This is the same
 * authority as a pin, pointed the other way: a pin says "the rules do not get to move
 * this", an override says "this rule does not get to stop me". Either way the person on
 * the floor outranks the engine, and the agent may not overrule them (CLAUDE.md #9).
 */
export function overrideConflict(
  s: SousState,
  a: { key: string },
  by: Actor,
): Result<{ key: string; left: number }> {
  if (by === 'agent') {
    return no('Only a human can override a conflict. Say what is wrong and let the host decide.');
  }
  const live = rawConflicts(s);
  const hit = live.find((c) => conflictKey(c) === a.key);
  if (!hit) return no('That conflict is no longer on the board.');
  if (s.overrides.includes(a.key)) return no(`${hit.message} is already overridden.`);

  // Drop keys whose conflict has since resolved itself, so the list cannot silently grow.
  const alive = new Set(live.map(conflictKey));
  s.overrides = [...s.overrides.filter((k) => alive.has(k)), a.key];
  const left = computeConflicts(s).length;
  return ok(
    `Overridden: ${hit.message} The board will stop raising it. ${left} conflict${left === 1 ? '' : 's'} left.`,
    { key: a.key, left },
  );
}

/** Put an overridden conflict back on the board. A human's call, both ways. */
export function restoreConflict(
  s: SousState,
  a: { key: string },
  by: Actor,
): Result<{ key: string }> {
  if (by === 'agent') return no('The host overrode that one. Only they can put it back.');
  if (!s.overrides.includes(a.key)) return no('That conflict is not overridden.');
  s.overrides = s.overrides.filter((k) => k !== a.key);
  return ok('Put it back on the board.', { key: a.key });
}

// --- Collaboration -----------------------------------------------------------

export function resolveNote(
  s: SousState,
  a: { noteId: string; response: string },
  _by: Actor,
): Result<{ noteId: string }> {
  const n = s.notes.find((x) => x.id === a.noteId);
  if (!n) return no(`There is no service note ${a.noteId}.`);
  if (n.status === 'resolved') return no(`${a.noteId} is already closed: "${n.response}"`);
  const response = (a.response ?? '').trim().slice(0, MAX_TEXT);
  if (!response) return no('Say how the note was handled — that is the whole point of closing it.');
  n.status = 'resolved';
  n.response = response;
  return ok(`Closed the ${n.from}'s note on ${n.tableId ?? 'the floor'}: "${response}"`, { noteId: n.id });
}

export function setPin(
  s: SousState,
  a: { targetId: string; pinned?: boolean },
  by: Actor,
): Result<{ targetId: string; pinned: boolean }> {
  const pinned = a.pinned ?? true;
  const table = findTable(s, a.targetId);
  const party = table ? partyAt(s, table.id) : s.parties.find((p) => p.id === a.targetId && p.course !== 'departed');
  const target = party ?? table;
  if (!target) return no(`There is nothing called ${a.targetId} to pin.`);
  // Only a human may unpin. The agent may pin, and it may not undo the host (§4).
  if (!pinned && by === 'agent') {
    const who = party ? party.name : table?.name;
    return no(`${who} was pinned by the host. Ask them to unpin it.`);
  }
  // Placement is free; PINNING is the commitment, so this is where legality is enforced.
  // Only for bare furniture: pinning an occupied table pins the PARTY (CLAUDE.md #9), and
  // "don't move these people" is about the people, not about where the table sits.
  if (pinned && !party && table) {
    const bad = placementErrors(s, table);
    if (bad.length) {
      return no(`${bad[0].message} Move ${table.name} clear before you pin it down.`);
    }
  }

  const label = party ? `${party.name} at ${table?.name ?? party.tableId}` : table?.name;
  if (target.pinned === pinned) return ok(`${label} is already ${pinned ? 'pinned' : 'unpinned'}.`, { targetId: a.targetId, pinned });
  target.pinned = pinned;
  return ok(
    pinned ? `Pinned ${label}. Tools will refuse to move ${party ? 'them' : 'it'} now.` : `Unpinned ${label}.`,
    { targetId: a.targetId, pinned },
  );
}

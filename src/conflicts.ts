// The conflict engine (SOUS_PLAN.md §2, CLAUDE.md #6).
//
// ONE function. `computeConflicts(state, 'design')` is the layout validator, and
// `computeConflicts(state, 'service')` is the board's alarm list — the same engine
// filtered, never a second implementation. `check_conflicts` exposes it directly and
// every mutation returns its findings so the agent self-corrects (§4).
//
// Pure and React-free, so scripts/ can run it headless. Geometry is in CELLS.
import { seatsUnder, stationLoad } from './sim.ts';
import { CELL_M, MIN_AISLE_CELLS, fmtClock } from './types.ts';
import type { Conflict, FloorPlan, SousState, Table, Wall } from './types.ts';

export type Scope = 'design' | 'service' | 'all';
/** [x1, y1, x2, y2] in cells. */
export type Box = [number, number, number, number];

/** Wall thickness in cells — walls are stored as segments and occupy 2 cells inward. */
const WALL_T = 2;
/** Covers one server may take in this window before the section is a pile-up. */
const PUSH_WINDOW = 15;
const PUSH_COVERS = 10;
/** Minutes past due before a ticket is worth shouting about. */
const LATE_GRACE = 3;
/** A section carrying more than this many times the leanest one is unbalanced. */
const BALANCE_RATIO = 1.5;

export const tableBox = (t: Table): Box => [
  t.x - t.w / 2, t.y - t.h / 2, t.x + t.w / 2, t.y + t.h / 2,
];

/** Walls are segments; they are drawn — and collide — 2 cells thick, inward. */
export function wallBox(w: Wall, bounds: FloorPlan['bounds']): Box {
  const [x1, x2] = [Math.min(w.x1, w.x2), Math.max(w.x1, w.x2)];
  const [y1, y2] = [Math.min(w.y1, w.y2), Math.max(w.y1, w.y2)];
  if (x1 === x2) {
    const x = x1 === bounds.w ? x1 - WALL_T : x1;
    return [x, y1, x + WALL_T, y2];
  }
  const y = y1 === bounds.h ? y1 - WALL_T : y1;
  return [x1, y, x2, y + WALL_T];
}

/**
 * Separation between two boxes, in cells. Positive is a gap; zero or less is an
 * overlap. Only the widest axis counts: two tables offset diagonally are not facing
 * each other across an aisle.
 */
export function gap(a: Box, b: Box): number {
  return Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
}

const mm = (cells: number) => Math.round(cells * CELL_M * 1000);
const stationBox = (st: FloorPlan['stations'][number]): Box => [
  st.x - st.w / 2, st.y - st.h / 2, st.x + st.w / 2, st.y + st.h / 2,
];

/** Top of the dining floor: below the kitchen line, derived rather than hardcoded. */
export function floorTop(plan: FloorPlan): number {
  return plan.walls
    .filter((w) => w.y1 === w.y2 && w.y1 < plan.bounds.h / 2)
    .reduce((y, w) => Math.max(y, wallBox(w, plan.bounds)[3]), WALL_T);
}

/** Everything a table has to keep clear of, besides the other tables. */
export function obstacles(plan: FloorPlan): { label: string; box: Box }[] {
  return [
    ...plan.walls.map((w) => ({
      label: w.kind === 'door' ? 'the door' : `the ${w.kind === 'window' ? 'window' : 'wall'}`,
      box: wallBox(w, plan.bounds),
    })),
    ...plan.stations.map((st) => ({ label: `the ${st.name.toLowerCase()} station`, box: stationBox(st) })),
  ];
}

// --- Design: is this room buildable? -----------------------------------------

function designConflicts(s: SousState): Conflict[] {
  const out: Conflict[] = [];
  const { bounds, tables, sections } = s.plan;
  const solids = obstacles(s.plan);

  // ponytail: no "table with no path to the pass" rule (§2). It needs a flood fill, and
  // nothing on the tool surface can build a wall, so today it could never fire. Ceiling —
  // it becomes load-bearing the moment addWall lands (SOUS_PLAN.md §8, conditional day 4);
  // upgrade is a coarse grid flood from the pass over the same obstacle boxes below.
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const a = tableBox(t);
    if (a[0] < 0 || a[1] < 0 || a[2] > bounds.w || a[3] > bounds.h) {
      out.push({
        type: 'off-floor', severity: 'error', targetId: t.id,
        message: `${t.name} sits outside the room.`,
        suggestion: `The room is ${bounds.w} x ${bounds.h} cells. Move it back inside.`,
      });
    }
    const near: { label: string; box: Box }[] = [
      ...tables.slice(i + 1).map((o) => ({ label: o.name, box: tableBox(o) })),
      ...solids,
    ];
    for (const o of near) {
      const d = gap(a, o.box);
      if (d <= 0) {
        out.push({
          type: 'overlap', severity: 'error', targetId: t.id,
          message: `${t.name} overlaps ${o.label}.`,
          suggestion: `Leave at least ${mm(MIN_AISLE_CELLS)}mm between them.`,
        });
      } else if (d < MIN_AISLE_CELLS) {
        out.push({
          type: 'aisle', severity: 'error', targetId: t.id,
          message: `The aisle between ${t.name} and ${o.label} is ${mm(d)}mm; the accessible minimum is ${mm(MIN_AISLE_CELLS)}mm.`,
          suggestion: `Move ${t.name} ${Math.ceil(MIN_AISLE_CELLS - d)} cells clear.`,
        });
      }
    }
  }

  const seatsIn = (ids: string[]) =>
    ids.reduce((n, id) => n + (tables.find((t) => t.id === id)?.seats ?? 0), 0);
  const staffed = sections.filter((sec) => sec.tableIds.length > 0);
  for (const sec of sections) {
    if (sec.tableIds.length && !sec.serverName.trim()) {
      out.push({
        type: 'section-unstaffed', severity: 'error', targetId: sec.id,
        message: `The ${sec.name} section has ${sec.tableIds.length} tables and no server.`,
        suggestion: 'Give it a server or move its tables to another section.',
      });
    }
  }
  if (staffed.length > 1) {
    const load = staffed.map((sec) => ({ sec, seats: seatsIn(sec.tableIds) }));
    const lean = load.reduce((a, b) => (b.seats < a.seats ? b : a));
    const heavy = load.reduce((a, b) => (b.seats > a.seats ? b : a));
    if (heavy.seats > lean.seats * BALANCE_RATIO) {
      out.push({
        type: 'section-balance', severity: 'warn', targetId: heavy.sec.id,
        message: `${heavy.sec.name} carries ${heavy.seats} seats against ${lean.sec.name}'s ${lean.seats}.`,
        suggestion: `Move a table from ${heavy.sec.name} to ${lean.sec.name}.`,
      });
    }
  }
  return out;
}

// --- Service: is this night under control? -----------------------------------

function serviceConflicts(s: SousState): Conflict[] {
  const out: Conflict[] = [];
  const clock = s.shift.clock;
  const menu = new Map(s.menu.map((m) => [m.id, m]));
  const live = s.parties.filter((p) => p.course !== 'departed');
  /** A conflict names the table a person can see; the ticket id goes in the suggestion. */
  const nameOf = (id: string) => s.plan.tables.find((t) => t.id === id)?.name ?? id;

  for (const p of live) {
    const seats = seatsUnder(s, p);
    if (p.size > seats) {
      out.push({
        type: 'party-oversize', severity: 'error', targetId: p.tableId ?? p.id,
        message: `${p.name} is ${p.size} on ${seats} seats.`,
        suggestion: 'Move them to a bigger table, or push two together.',
      });
    }
  }

  for (const t of s.tickets) {
    const open = t.items.filter((i) => i.status !== 'served');
    if (!open.length) continue;
    const table = s.parties.find((p) => p.id === t.partyId)?.tableId ?? t.partyId;
    for (const i of open) {
      const m = menu.get(i.menuItemId);
      if (m?.is86d) {
        out.push({
          type: 'ticket-86', severity: 'error', targetId: table,
          message: `${nameOf(table)}'s ${t.course} still have ${m.name} on them, and ${m.name} is 86'd.`,
          suggestion: `swap_ticket_item on ${t.id} to another ${t.course} dish, or drop the line.`,
        });
      }
    }
    // ponytail: lateness stands in for §2's "mains landing more than 2 minutes apart".
    // Ceiling — the engine starts every item as soon as a slot frees, so plate times
    // spread by the cook-time difference on almost every ticket and a spread rule would
    // fire constantly. Upgrade is to start items at dueAt - cookMinutes in startItems
    // (real expo behaviour), after which the spread rule becomes the rare, useful one.
    if (t.firedAt <= clock && clock > t.dueAt + LATE_GRACE) {
      out.push({
        type: 'ticket-late', severity: 'warn', targetId: table,
        message: `${nameOf(table)}'s ${t.course} were due at ${fmtClock(t.dueAt)} and are ${clock - t.dueAt} minutes late.`,
        suggestion: `retime_ticket ${t.id} to pull it forward, or tell the table.`,
      });
    }
  }

  const queued = stationLoad(s, 'queued');
  for (const st of s.plan.stations) {
    const backlog = queued[st.type] ?? 0;
    if (backlog > st.concurrency) {
      out.push({
        type: 'station-backlog', severity: 'warn', targetId: st.id,
        message: `${st.name} has ${backlog} waiting on ${st.concurrency} burners.`,
        suggestion: 'Re-time what is not urgent, or 86 the slowest item.',
      });
    }
  }

  const push: Record<string, number> = {};
  for (const p of live) {
    if (clock - p.seatedAt >= PUSH_WINDOW || !p.tableId) continue;
    const sec = s.plan.sections.find((x) => x.tableIds.includes(p.tableId as string));
    if (sec) push[sec.id] = (push[sec.id] ?? 0) + p.size;
  }
  for (const sec of s.plan.sections) {
    if ((push[sec.id] ?? 0) > PUSH_COVERS) {
      out.push({
        type: 'server-push', severity: 'warn', targetId: sec.id,
        message: `${sec.serverName} took ${push[sec.id]} covers in ${PUSH_WINDOW} minutes across ${sec.name}.`,
        suggestion: 'Seat the next party in a quieter section.',
      });
    }
  }

  for (const r of s.reservations) {
    if (r.status !== 'arrived') continue;
    const waiting = clock - r.time;
    if (waiting < PUSH_WINDOW) continue;
    out.push({
      type: 'reservation-waiting', severity: 'warn', targetId: r.id,
      message: `${r.name} (${r.size}) booked for ${fmtClock(r.time)} has been standing ${waiting} minutes.`,
      suggestion: 'seat_party, or combine two tables to make the size.',
    });
  }

  for (const w of s.waitlist) {
    const waited = clock - w.addedAt;
    if (waited > w.quotedMinutes) {
      out.push({
        type: 'quote-blown', severity: 'warn', targetId: w.id,
        message: `${w.name} (${w.size}) was quoted ${w.quotedMinutes} minutes and has waited ${waited}.`,
        suggestion: 'Seat them or re-quote before they walk.',
      });
    }
  }

  return out;
}

/** The whole engine. `scope` filters which half runs; nothing else differs. */
export function computeConflicts(s: SousState, scope: Scope = 'all'): Conflict[] {
  return [
    ...(scope === 'service' ? [] : designConflicts(s)),
    ...(scope === 'design' ? [] : serviceConflicts(s)),
  ];
}

export const errorsOnly = (c: Conflict[]) => c.filter((x) => x.severity === 'error');

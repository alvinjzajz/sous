// Runnable consistency check for the seed scenario: npm run check
//
// The seed is the single biggest execution risk (SOUS_PLAN.md §7) — every tool
// depends on its shape, and an inconsistent room fails silently rather than loudly.
// Asserts only; no framework.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { floorPlan, menu, notes, reservations, seedState } from '../src/seed.ts';
import { MIN_AISLE_CELLS } from '../src/types.ts';
import type { Table } from '../src/types.ts';

const { bounds, tables, sections, stations, walls } = floorPlan;
/** Interior face of the perimeter walls, in cells. */
const WALL = 2;

/** Table footprint as [x1, y1, x2, y2] in cells. */
const box = (t: Table): [number, number, number, number] => [
  t.x - t.w / 2, t.y - t.h / 2, t.x + t.w / 2, t.y + t.h / 2,
];

// --- Geometry ---------------------------------------------------------------

assert.equal(tables.length, 16, 'expected 16 tables');
assert.equal(tables.reduce((n, t) => n + t.seats, 0), 60, 'expected 60 seats');

for (const t of tables) {
  for (const [k, v] of Object.entries({ x: t.x, y: t.y, w: t.w, h: t.h })) {
    assert.equal(v, Math.round(v), `${t.id}.${k} is not a whole cell (${v})`);
  }
  if (t.shape === 'round') assert.equal(t.w, t.h, `${t.id} is round but not square`);
  const [x1, y1, x2, y2] = box(t);
  assert.ok(
    x1 >= WALL && y1 >= WALL && x2 <= bounds.w - WALL && y2 <= bounds.h - WALL,
    `${t.id} is outside the room`,
  );
  // Clearance to the perimeter. The dining floor starts below the kitchen line at y=20.
  const toWall = Math.min(x1 - WALL, bounds.w - WALL - x2, bounds.h - WALL - y2, y1 - 22);
  assert.ok(
    toWall >= MIN_AISLE_CELLS,
    `${t.id} sits ${(toWall * 125).toFixed(0)}mm from a wall; minimum is 915mm`,
  );
}

// ponytail: clearance is measured table-edge to table-edge, so chairs are not modelled
// as obstructions. Upgrade path is to inflate each box by one chair depth (4 cells) in
// computeConflicts on day 3 — same loop, one extra term — and re-space the room to suit.
for (let i = 0; i < tables.length; i++) {
  for (let j = i + 1; j < tables.length; j++) {
    const [a, b] = [box(tables[i]), box(tables[j])];
    const gapX = Math.max(a[0] - b[2], b[0] - a[2]);
    const gapY = Math.max(a[1] - b[3], b[1] - a[3]);
    const pair = `${tables[i].id}/${tables[j].id}`;
    assert.ok(gapX > 0 || gapY > 0, `${pair} overlap`);
    // Only tables facing each other across an aisle need the clearance.
    const gap = Math.max(gapX, gapY);
    assert.ok(gap >= MIN_AISLE_CELLS, `${pair} aisle is ${(gap * 125).toFixed(0)}mm, minimum 915mm`);
  }
}

for (const w of walls) {
  assert.ok(w.x1 === w.x2 || w.y1 === w.y2, `${w.id} is not axis-aligned`);
}

// --- Sections, stations, menu ------------------------------------------------

const assigned = sections.flatMap((s) => s.tableIds);
assert.equal(new Set(assigned).size, assigned.length, 'a table is in two sections');
assert.deepEqual(
  [...assigned].sort(),
  tables.map((t) => t.id).sort(),
  'sections do not cover exactly the tables that exist',
);
for (const t of tables) {
  assert.ok(
    sections.some((s) => s.id === t.sectionId && s.tableIds.includes(t.id)),
    `${t.id}.sectionId disagrees with its section`,
  );
}

// The palette tokens sections reference must actually exist (§6.1).
const themeCss = readFileSync('src/theme.css', 'utf8');
for (const s of sections) {
  assert.ok(themeCss.includes(`${s.color}:`), `${s.name} uses ${s.color}, undefined in theme.css`);
}

const stationTypes = new Set(stations.map((s) => s.type));
assert.equal(menu.length, 22, 'expected 22 menu items');
for (const m of menu) {
  assert.ok(stationTypes.has(m.stationType), `${m.name} routes to missing station ${m.stationType}`);
  assert.ok(m.cookMinutes > 0 && m.cookMinutes <= 30, `${m.name} has an implausible cook time`);
}
for (const course of ['drinks', 'apps', 'mains', 'dessert'] as const) {
  assert.ok(menu.some((m) => m.course === course), `no ${course} on the menu`);
}

// --- The book ----------------------------------------------------------------

assert.equal(reservations.length, 12, 'expected 12 reservations');
assert.equal(reservations.reduce((n, r) => n + r.size, 0), 38, 'expected 38 booked covers');
for (const r of reservations) {
  assert.ok(
    tables.some((t) => t.seats >= r.size),
    `${r.name} (${r.size}) does not fit any single table`,
  );
  assert.ok(r.time >= 60 && r.time <= 240, `${r.name} is booked outside 6:00-9:00 PM`);
}

// Notes must surface mid-shift and point at tables that exist.
for (const n of notes) {
  assert.ok(n.createdAt > 0, `${n.id} surfaces before the shift starts`);
  assert.ok(n.text.length <= 200, `${n.id} exceeds the 200-char free-text cap (§12.1)`);
  if (n.tableId) assert.ok(tables.some((t) => t.id === n.tableId), `${n.id} points at a missing table`);
}

// --- The shift starts empty (§7) ---------------------------------------------

const s = seedState();
assert.equal(s.parties.length, 0, 'the seed must not pre-seat anyone');
assert.equal(s.tickets.length, 0, 'the seed must not pre-fire tickets');
assert.equal(s.shift.clock, 0, 'the shift starts at 5:00 PM');
assert.equal(s.shift.mode, 'design', 'the shift starts in design mode');
assert.ok(s.menu.every((m) => !m.is86d), 'nothing is 86d at open');

console.log(
  `seed ok — ${tables.length} tables / ${tables.reduce((n, t) => n + t.seats, 0)} seats, ` +
    `${sections.length} sections, ${stations.length} stations, ${menu.length} menu items, ` +
    `${reservations.length} reservations / ${reservations.reduce((n, r) => n + r.size, 0)} covers`,
);

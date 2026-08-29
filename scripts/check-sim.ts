// Runnable check for the simulation engine: npm run check
//
// Runs a full headless shift, open to close, and asserts the invariants that
// SOUS_PLAN.md §8 names as the day-2 risk: no item finishes before it starts, no
// station ever exceeds its concurrency, and every reservation is either seated or
// visibly still waiting. Plus determinism, which is the whole demo's contract.
// Asserts only; no framework.
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { LAST_SEAT, SERVICE_END, advanceTo, stationLoad, tick, ticketServedAt } from '../src/sim.ts';
import type { CourseStage, SousState } from '../src/types.ts';
import { fmtClock } from '../src/types.ts';

const STAGES: CourseStage[] = [
  'seated', 'drinks', 'apps', 'mains', 'dessert', 'check', 'departed',
];

const cap = new Map(seedState().plan.stations.map((st) => [st.type, st.concurrency]));
const stageOf = (c: CourseStage) => STAGES.indexOf(c);

// --- Walk the whole shift a minute at a time ---------------------------------

let s = seedState();
const seenStage = new Map<string, number>();
let peakCovers = 0;
let peakWaitlist = 0;
let at715: SousState | null = null;

// Run until the clock stops itself. Service ends when the last table leaves, not at a
// fixed hour, so the loop cannot assume a length — it ends when a tick stops advancing.
let minute = 0;
for (;;) {
  const next = tick(s);
  if (next.shift.clock === s.shift.clock) {
    s = next;
    break; // service is over
  }
  s = next;
  minute += 1;
  const where = `${fmtClock(s.shift.clock)}`;
  assert.equal(s.shift.clock, minute, 'the clock skipped a minute');
  assert.ok(minute <= SERVICE_END, `the shift ran past its ${SERVICE_END}-minute ceiling`);

  const menu = new Map(s.menu.map((m) => [m.id, m]));

  // Cooking never starts before the ticket is fired, and never before the clock.
  for (const t of s.tickets) {
    for (const it of t.items) {
      if (it.startedAt === null) {
        assert.equal(it.status, 'queued', `${t.id} item ${it.menuItemId} runs without a start time`);
        continue;
      }
      assert.ok(it.startedAt >= t.firedAt, `${t.id} started at ${it.startedAt}, fired at ${t.firedAt}`);
      assert.ok(it.startedAt <= s.shift.clock, `${t.id} started in the future at ${where}`);
      const done = it.startedAt + (menu.get(it.menuItemId)?.cookMinutes ?? 0);
      if (it.status === 'cooking') {
        assert.ok(s.shift.clock < done, `${t.id} still cooking past ${done} at ${where}`);
      } else {
        assert.ok(s.shift.clock >= done, `${t.id} plated before it finished at ${where}`);
      }
    }
    // A course lands together: no item is served while a sibling is still on the stove.
    const statuses = new Set(t.items.map((i) => i.status));
    assert.ok(
      !statuses.has('served') || statuses.size === 1,
      `${t.id} served a split course at ${where}`,
    );
    const served = ticketServedAt(t, menu);
    if (statuses.has('served')) {
      assert.ok(served !== null && s.shift.clock >= served, `${t.id} served early at ${where}`);
    }
  }

  // Station concurrency is a hard ceiling, checked every single minute.
  for (const [type, load] of Object.entries(stationLoad(s))) {
    assert.ok(load <= (cap.get(type as never) ?? 0), `${type} ran ${load} at once at ${where}`);
  }

  // One live party per table, and everyone fits the table they are on.
  const occupied = new Set<string>();
  for (const p of s.parties) {
    if (p.course === 'departed') {
      assert.equal(p.tableId, null, `${p.name} departed but still holds a table`);
      continue;
    }
    assert.ok(p.tableId, `${p.name} is live with no table at ${where}`);
    assert.ok(!occupied.has(p.tableId as string), `two parties on ${p.tableId} at ${where}`);
    occupied.add(p.tableId as string);
    const table = s.plan.tables.find((t) => t.id === p.tableId);
    assert.ok(table && table.seats >= p.size, `${p.name} (${p.size}) is on ${p.tableId}`);
    assert.ok(p.courseAt <= s.shift.clock, `${p.name}.courseAt is in the future`);
    assert.ok(p.seatedAt <= p.courseAt, `${p.name} changed course before sitting down`);
  }

  // Courses only ever run forwards.
  for (const p of s.parties) {
    const prev = seenStage.get(p.id) ?? -1;
    assert.ok(stageOf(p.course) >= prev, `${p.name} went backwards to ${p.course} at ${where}`);
    seenStage.set(p.id, stageOf(p.course));
  }

  // Live covers never exceed the seats in the room. The UI reads this to draw its
  // meter, and summing departed parties too is exactly how that went wrong once.
  const liveCovers = s.parties
    .filter((p) => p.course !== 'departed')
    .reduce((n, p) => n + p.size, 0);
  const seats = s.plan.tables.reduce((n, t) => n + t.seats, 0);
  assert.ok(liveCovers <= seats, `${liveCovers} covers seated in a ${seats}-seat room at ${where}`);

  peakCovers = Math.max(peakCovers, [...occupied].length);
  peakWaitlist = Math.max(peakWaitlist, s.waitlist.length);
  if (s.shift.clock === 135) at715 = structuredClone(s);
}

const CLOSE = s.shift.clock;

// --- The night actually finishes ---------------------------------------------
// Service ends when the room empties, not when an arbitrary constant says so. A shift
// that stops with people still eating and food on the stove is a truncated night.

assert.ok(CLOSE < SERVICE_END, `service hit the ${SERVICE_END}-minute ceiling instead of ending`);
assert.ok(CLOSE > LAST_SEAT, 'service ended before the last seating had even passed');
assert.equal(s.shift.running, false, 'the clock is still running after close');
assert.equal(
  s.parties.filter((p) => p.course !== 'departed').length, 0,
  'the shift ended with people still at tables',
);
assert.equal(
  s.tickets.filter((t) => t.items.some((i) => i.status !== 'served')).length, 0,
  'the shift ended with food still on the stove',
);
for (const [type, load] of Object.entries(stationLoad(s))) {
  assert.equal(load, 0, `${type} was still cooking at close`);
}
assert.equal(s.waitlist.length, 0, 'someone was left standing on the waitlist at close');

// --- Nobody is silently dropped ----------------------------------------------
// §7 requires the book to be seatable in this room. Every booking gets a table.

for (const r of s.reservations) {
  assert.equal(r.status, 'seated', `${r.name} ended the night as ${r.status}`);
}

// Every party that sat down ran the whole arc and left.
for (const p of s.parties) {
  assert.equal(p.course, 'departed', `${p.name} ended the night at ${p.course}`);
  assert.equal(p.tableId, null, `${p.name} departed but still holds ${p.tableId}`);
}

// --- The room at 7:15 PM is the demo's opening shot (§9, 1:15) ----------------

assert.ok(at715, 'never reached 7:15 PM');
const live = at715.parties.filter((p) => p.course !== 'departed');
const covers = live.reduce((n, p) => n + p.size, 0);
const roomSeats = at715.plan.tables.reduce((n, t) => n + t.seats, 0);
assert.ok(
  live.length >= 8 && live.length <= 15,
  `7:15 PM has ${live.length} of 16 tables occupied; wanted a room in service, not empty or wedged`,
);
assert.ok(at715.tickets.length > 0, '7:15 PM has no tickets in flight');
assert.ok(
  at715.tickets.some((t) => t.items.some((i) => i.status === 'cooking')),
  'nothing is on the stove at 7:15 PM',
);

// --- Determinism: same seed, same night --------------------------------------

const a = advanceTo(seedState(), 135);
const b = advanceTo(seedState(), 135);
assert.deepEqual(a, b, 'two runs of the same seed diverged');
assert.deepEqual(a, at715, 'advanceTo disagrees with ticking a minute at a time');

// advanceTo well past close must terminate on the stalled clock rather than spin,
// and land on exactly the same close as ticking one minute at a time.
const late = advanceTo(seedState(), 5000);
assert.equal(late.shift.clock, CLOSE, 'advanceTo disagrees with the tick loop on close');
assert.equal(late.shift.running, false, 'the clock is still running after close');

// tick is pure: it must not touch the state it was handed.
const before = seedState();
const snapshot = structuredClone(before);
tick(before);
assert.deepEqual(before, snapshot, 'tick mutated its argument');

// Nothing on the shift but the clock changes on a quiet tick, and no undo state exists
// inside the sim at all — snapshots are the day-3 mutation path's problem (§2, rule 3).
assert.equal(a.shift.seed, snapshot.shift.seed, 'the seed drifted');
assert.equal(a.shift.mode, snapshot.shift.mode, 'the sim changed mode behind our back');

const byCourse = live.reduce<Record<string, number>>(
  (acc, p) => ({ ...acc, [p.course]: (acc[p.course] ?? 0) + 1 }),
  {},
);
console.log(
  `sim ok — 5:00 PM to ${fmtClock(CLOSE)} in ${CLOSE} ticks, deterministic, room empty at close.\n` +
    `  7:15 PM: ${live.length}/16 tables, ${covers}/${roomSeats} covers, ` +
    `${at715.tickets.filter((t) => t.items.some((i) => i.status !== 'served')).length} tickets in flight, ` +
    `${at715.waitlist.length} waiting, ` +
    `${at715.reservations.filter((r) => r.status === 'arrived').length} arrived unseated\n` +
    `  by course: ${Object.entries(byCourse).map(([k, v]) => `${k} ${v}`).join(', ')}\n` +
    `  night: peak ${peakCovers}/16 tables, peak waitlist ${peakWaitlist}, ` +
    `${s.parties.length} parties served, ${s.tickets.length} tickets`,
);

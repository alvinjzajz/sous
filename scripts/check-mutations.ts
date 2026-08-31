// Runnable check for the mutation path: npm run check
//
// Three things land on day 3 and all three are invariants rather than features:
//   1. Every mutation is a plain function that refuses cleanly and never half-writes.
//   2. Pins block everyone; only a human may unpin.
//   3. Undo rewinds the board and NOT the clock (SOUS_PLAN.md §2, CLAUDE.md #3).
// Plus: every conflict rule can actually fire, so none of them is dead code.
// Asserts only; no framework.
import assert from 'node:assert/strict';
import { computeConflicts, errorsOnly } from '../src/conflicts.ts';
import {
  addTable, addToWaitlist, applyLayoutTemplate, assignSection, clearTable, fireCourse,
  moveParty, protoFor, removeTable, reshape, resolveNote, restore, retimeTicket,
  seatParty, setItem86, setPin, snapshot, swapTicketItem, updateTable,
} from '../src/mutations.ts';
import type { Result } from '../src/mutations.ts';
import { floorPlan, seedState } from '../src/seed.ts';
import { advanceTo, tick } from '../src/sim.ts';
import type { SousState } from '../src/types.ts';

/** The demo's room: 7:15 PM, three-quarters full, tickets in flight (§9, 1:15). */
const PEAK = 135;
const peak = () => advanceTo(seedState(), PEAK);
const types = (s: SousState, scope: 'design' | 'service' | 'all' = 'all') =>
  new Set(computeConflicts(s, scope).map((c) => c.type));

const say = (r: Result<unknown>) => r.message;
function must<T>(r: Result<T>, why: string): T | undefined {
  assert.ok(r.ok, `${why} — refused with: ${r.message}`);
  return r.ok ? r.data : undefined;
}
function refused(r: Result<unknown>, why: string, mentions?: string) {
  assert.ok(!r.ok, `${why} — but it was allowed: ${r.message}`);
  if (mentions) {
    assert.ok(
      r.message.toLowerCase().includes(mentions.toLowerCase()),
      `${why} — the refusal never mentions ${mentions}: "${r.message}"`,
    );
  }
}

// --- The seed room passes its own validator ----------------------------------
// check-seed.ts asserts the seed's geometry by hand. This asserts the ENGINE agrees,
// which is the thing every layout tool will be judged against.

assert.deepEqual(computeConflicts(seedState(), 'design'), [], 'the seeded room fails its own layout check');
assert.deepEqual(computeConflicts(seedState(), 'all'), [], 'the seeded room opens with conflicts');
assert.deepEqual(computeConflicts(peak(), 'design'), [], 'service broke the layout');

// --- Every rule can fire ------------------------------------------------------
// A conflict rule that can never fire is dead code that looks like safety.

const fired: string[] = [];
const fires = (label: string, build: (s: SousState) => void, type: string) => {
  const state = peak();
  build(state);
  fired.push(type);
  assert.ok(types(state).has(type), `${label}: expected a ${type} conflict, got ${[...types(state)].join(', ') || 'none'}`);
};

fires('two tables in one place', (s) => {
  const [a, b] = s.plan.tables;
  b.x = a.x;
  b.y = a.y;
}, 'overlap');
fires('a 500mm aisle', (s) => {
  const [a, b] = s.plan.tables;
  b.x = a.x + a.w / 2 + b.w / 2 + 4;
  b.y = a.y;
}, 'aisle');
fires('a table in the car park', (s) => {
  s.plan.tables[0].x = s.plan.bounds.w + 40;
}, 'off-floor');
fires('a section with no server', (s) => {
  s.plan.sections[0].serverName = '';
}, 'section-unstaffed');
fires('one server carrying the room', (s) => {
  const [sage, , , bar] = s.plan.sections;
  sage.tableIds = [...sage.tableIds, ...bar.tableIds];
  bar.tableIds = [];
}, 'section-balance');
fires('six people on a four-top', (s) => {
  s.parties.find((p) => p.course !== 'departed')!.size = 12;
}, 'party-oversize');
fires('an 86 landing on an open ticket', (s) => {
  const open = s.tickets.find((t) => t.items.some((i) => i.status !== 'served'))!;
  s.menu.find((m) => m.id === open.items[0].menuItemId)!.is86d = true;
}, 'ticket-86');
fires('a ticket ten minutes past due', (s) => {
  const open = s.tickets.find((t) => t.items.some((i) => i.status !== 'served'))!;
  open.dueAt = s.shift.clock - 10;
  open.firedAt = Math.min(open.firedAt, s.shift.clock);
}, 'ticket-late');
fires('one burner and three steaks', (s) => {
  const grill = s.plan.stations.find((st) => st.type === 'grill')!;
  grill.concurrency = 1;
  const party = s.parties.find((p) => p.course !== 'departed' && !s.tickets.some((t) => t.partyId === p.id && t.course === 'dessert'))!;
  const grillItems = s.menu.filter((m) => m.stationType === 'grill' && m.course === 'mains').slice(0, 3);
  s.tickets = s.tickets.filter((t) => !(t.partyId === party.id && t.course === 'mains'));
  must(fireCourse(s, { partyId: party.id, course: 'mains', items: grillItems.map((m) => ({ menuItemId: m.id, qty: 1 })) }, 'agent'), 'firing three grill mains');
}, 'station-backlog');
fires('a booking left standing', (s) => {
  const r = s.reservations.find((x) => x.status !== 'seated') ?? s.reservations[0];
  r.status = 'arrived';
  r.time = s.shift.clock - 30;
}, 'reservation-waiting');
fires('a quote that blew', (s) => {
  s.waitlist.push({ id: 'w-test', name: 'Bergstrom', size: 2, addedAt: s.shift.clock - 40, quotedMinutes: 10 });
}, 'quote-blown');
{
  const s = peak();
  const sage = s.plan.sections[0];
  for (const [i, id] of sage.tableIds.entries()) {
    const sitting = s.parties.find((p) => p.course !== 'departed' && p.tableId === id);
    if (sitting) clearTable(s, { tableId: id }, 'human');
    seatParty(s, { tableIds: [id], name: `Push ${i}`, size: 4 }, 'human');
  }
  assert.ok(types(s).has('server-push'), 'a server taking the whole room raises nothing');
  fired.push('server-push');
}

// --- Refusals never write -----------------------------------------------------
// The store discards a refused draft, but a mutation that half-writes before saying
// no would still be a bug the day something calls it directly.

{
  const base = peak();
  const pinnedTable = base.plan.tables[0].id;
  setPin(base, { targetId: pinnedTable }, 'human');
  const badCalls: [string, (s: SousState) => Result<unknown>][] = [
    ['addTable with 40 seats', (s) => addTable(s, { seats: 40 }, 'agent')],
    ['addTable onto another table', (s) => addTable(s, { seats: 2, x: s.plan.tables[1].x, y: s.plan.tables[1].y }, 'agent')],
    ['updateTable on a pinned table', (s) => updateTable(s, { tableId: pinnedTable, seats: 8 }, 'agent')],
    ['updateTable to nowhere', (s) => updateTable(s, { tableId: s.plan.tables[1].id, x: -50 }, 'agent')],
    ['removeTable on a pinned table', (s) => removeTable(s, { tableId: pinnedTable }, 'human')],
    ['assignSection to a section that is not there', (s) => assignSection(s, { tableIds: [s.plan.tables[1].id], sectionId: 'sec-nope' }, 'agent')],
    ['applyLayoutTemplate mid-service', (s) => applyLayoutTemplate(s, { template: 'bistro' }, 'agent')],
    ['addToWaitlist with no name', (s) => addToWaitlist(s, { name: '  ', size: 2 }, 'agent')],
    ['seatParty at a table that is not there', (s) => seatParty(s, { tableIds: ['T99'], name: 'Nobody', size: 2 }, 'agent')],
    ['moveParty onto an occupied table', (s) => {
      const live = s.parties.filter((p) => p.course !== 'departed');
      return moveParty(s, { partyId: live[0].id, tableIds: [live[1].tableId as string] }, 'agent');
    }],
    ['clearTable on an empty table', (s) => clearTable(s, { tableId: emptyTable(s) }, 'agent')],
    ['fireCourse with an invented dish', (s) => fireCourse(s, { tableId: occupiedTable(s), course: 'mains', items: [{ menuItemId: 'm-unicorn', qty: 1 }] }, 'agent')],
    ['retimeTicket by nothing', (s) => retimeTicket(s, { ticketId: s.tickets[0].id, byMinutes: 0 }, 'agent')],
    ['swapTicketItem on a ticket that is not there', (s) => swapTicketItem(s, { ticketId: 'tk-nope', menuItemId: 'm-salmon' }, 'agent')],
    ['setItem86 on nothing', (s) => setItem86(s, { menuItemId: 'm-unicorn' }, 'agent')],
    ['resolveNote with no response', (s) => resolveNote(s, { noteId: s.notes[0].id, response: '' }, 'agent')],
    ['setPin on nothing', (s) => setPin(s, { targetId: 'nothing-here' }, 'agent')],
  ];
  for (const [label, call] of badCalls) {
    const draft = structuredClone(base);
    const before = structuredClone(draft);
    refused(call(draft), label);
    assert.deepEqual(draft, before, `${label} refused but wrote to state anyway`);
  }
}

function emptyTable(s: SousState): string {
  const taken = new Set(s.parties.filter((p) => p.course !== 'departed').flatMap((p) => [p.tableId, ...p.joinedIds]));
  return s.plan.tables.find((t) => !taken.has(t.id))!.id;
}
function occupiedTable(s: SousState): string {
  return s.parties.find((p) => p.course !== 'departed')!.tableId as string;
}

// --- Pins block everyone; only a human unpins ---------------------------------

{
  const s = seedState();
  const t = s.plan.tables[0];
  must(setPin(s, { targetId: t.name }, 'human'), 'a human pinning a table');
  assert.ok(t.pinned, 'the pin did not stick');
  refused(updateTable(s, { tableId: t.name, seats: 6 }, 'agent'), 'an agent resizing a pinned table', 'pinned');
  refused(updateTable(s, { tableId: t.name, seats: 6 }, 'human'), 'a human resizing a pinned table', 'pinned');
  refused(removeTable(s, { tableId: t.name }, 'agent'), 'an agent removing a pinned table', 'pinned');
  refused(assignSection(s, { tableIds: [t.name], sectionId: 'sec-rose' }, 'agent'), 're-sectioning a pinned table', 'pinned');
  refused(setPin(s, { targetId: t.name, pinned: false }, 'agent'), 'an agent unpinning', 'host');
  must(setPin(s, { targetId: t.name, pinned: false }, 'human'), 'a human unpinning');
  must(updateTable(s, { tableId: t.name, seats: 6 }, 'agent'), 'resizing once it is unpinned');
}

{
  // §9, 2:40: the refusal that has to be legible on screen.
  const s = peak();
  const table = occupiedTable(s);
  must(setPin(s, { targetId: table }, 'human'), 'pinning the party at a table');
  const party = s.parties.find((p) => p.tableId === table)!;
  assert.ok(party.pinned, 'pinning an occupied table must pin the party, not the furniture');
  refused(moveParty(s, { partyId: party.id, tableIds: [emptyTable(s)] }, 'agent'), 'moving a pinned party', 'note');
  refused(clearTable(s, { tableId: table }, 'agent'), 'clearing a pinned party', 'pinned');
  refused(updateTable(s, { tableId: table, x: 40 }, 'agent'), 'moving the table out from under a pinned party', 'pinned');
}

// --- Design mutations ---------------------------------------------------------

{
  const s = seedState();
  const before = s.plan.tables.length;
  const t = must(addTable(s, { seats: 2, anchor: 'corner-sw' }, 'agent'), 'placing a two-top by anchor')!;
  assert.equal(s.plan.tables.length, before + 1, 'the table never landed');
  assert.equal(t.provenance, 'agent', 'an agent-placed table is not stamped agent');
  assert.deepEqual(computeConflicts(s, 'design'), [], `anchored placement broke the room: ${computeConflicts(s, 'design')[0]?.message}`);
  assert.ok(s.plan.sections.some((sec) => sec.tableIds.includes(t.id)), 'a new table belongs to no section');

  // Raw coordinates that do not work come back with somewhere that does (§4).
  const onTop = s.plan.tables[1];
  const bad = addTable(s, { seats: 2, x: onTop.x, y: onTop.y }, 'agent');
  refused(bad, 'placing a table on top of another');
  assert.ok(/x \d+, y \d+/.test(say(bad)), `the refusal offers no alternative spot: "${say(bad)}"`);

  refused(addTable(s, { seats: 4, name: 'T1' }, 'agent'), 'reusing a table name', 'already');
  refused(addTable(s, { seats: 0 }, 'agent'), 'a table with no seats');
}

{
  // The five day-4 quick actions are all updateTable underneath (§4), so this is what
  // Rotate, Grow and Shrink will actually do — including refusing to eat an aisle.
  const s = seedState();
  const round = s.plan.tables.find((t) => t.shape === 'round' && t.w > 8)!;
  must(updateTable(s, { tableId: round.id, w: 8 }, 'human'), 'shrinking a round table');
  assert.equal(round.w, round.h, 'a round table stopped being square');
  assert.equal(round.provenance, 'human', 'the human who moved it does not own it');
  refused(updateTable(s, { tableId: round.id, w: 24 }, 'human'), 'growing a table into the aisle', 'aisle');
  assert.equal(round.w, 8, 'the refused grow resized it anyway');
}

{
  // Rotation needs room. This room is packed with its rect tables running east-west,
  // so clearing the two neighbours is what makes the 90 degrees legal at all.
  const s = seedState();
  must(removeTable(s, { tableId: 'T5' }, 'human'), 'clearing space to rotate');
  must(removeTable(s, { tableId: 'T7' }, 'human'), 'clearing space to rotate');
  const rect = s.plan.tables.find((t) => t.id === 'T6')!;
  const [w, h] = [rect.w, rect.h];
  must(updateTable(s, { tableId: rect.id, w: h, h: w }, 'human'), 'rotating a rect table 90 degrees');
  assert.deepEqual([rect.w, rect.h], [h, w], 'the rotation did not take');
  // Two tables fewer leaves the sections uneven, which is a warning, not a broken room.
  assert.deepEqual(computeConflicts(s, 'design').filter((c) => c.severity === 'error'), [], 'the rotation broke the room');
}

{
  const s = seedState();
  const t = s.plan.tables[5];
  const sec = s.plan.sections.find((x) => !x.tableIds.includes(t.id))!;
  must(assignSection(s, { tableIds: [t.id], sectionId: sec.name }, 'agent'), 'assigning a section by name');
  assert.equal(t.sectionId, sec.id, 'the table disagrees with its section');
  assert.equal(s.plan.sections.filter((x) => x.tableIds.includes(t.id)).length, 1, 'the table is in two sections');

  must(removeTable(s, { tableId: t.id }, 'human'), 'removing an empty table');
  assert.ok(!s.plan.sections.some((x) => x.tableIds.includes(t.id)), 'a removed table is still in a section');
}

// --- day 4: the design-mode gate and the six quick actions --------------------

{
  // The gate is a guard in the MUTATION, not a hidden button, so a tool refuses with
  // the same sentence a person sees (§8, "Design mode's human half"). Note advanceTo
  // does not set mode — only the store's jumpTo and Run do — so this sets it by hand.
  const s = peak();
  s.shift.mode = 'service';
  const id = emptyTable(s);
  refused(addTable(s, { seats: 2, anchor: 'centre' }, 'agent'), 'adding a table mid-service', 'design mode');
  refused(updateTable(s, { tableId: id, seats: 4 }, 'agent'), 'resizing a table mid-service', 'design mode');
  refused(removeTable(s, { tableId: id }, 'human'), 'removing a table mid-service', 'design mode');
  refused(applyLayoutTemplate(s, { template: 'bistro' }, 'agent'), 'relaying the room mid-service', 'design mode');
  assert.equal(s.plan.tables.length, peak().plan.tables.length, 'a refused design edit changed the room');

  // Deliberately NOT gated: server-push is a service-scope conflict rule and
  // re-sectioning is the only mutation that clears it.
  const other = s.plan.sections.find((x) => !x.tableIds.includes(id))!;
  must(assignSection(s, { tableIds: [id], sectionId: other.id }, 'agent'), 're-sectioning during service');

  s.shift.mode = 'design';
  must(updateTable(s, { tableId: id, seats: 4 }, 'agent'), 'resizing once the room is back in design mode');
}

{
  // The four reshape buttons are arguments to updateTable and nothing else, so seats and
  // footprint cannot disagree — and null is a DISABLED button, never a dead one (§4).
  const s = seedState();
  const grid = s.plan.gridSize;
  const two = s.plan.tables.find((t) => t.shape === 'round' && t.seats === 2)!;
  const four = s.plan.tables.find((t) => t.shape === 'round' && t.seats === 4)!;
  const rect = s.plan.tables.find((t) => t.shape === 'rect')!;

  assert.equal(reshape(two, 'rotate', grid), null, 'rotate is live on a round table, where it is a no-op');
  assert.ok(reshape(rect, 'rotate', grid), 'rotate is disabled on a rect table, where it is the whole point');
  assert.equal(reshape(two, 'shrink', grid), null, 'shrink ran off the bottom of the seat range');
  assert.equal(reshape({ ...rect, seats: 12 }, 'grow', grid), null, 'grow ran off the top of the seat range');

  const wide = reshape(two, 'widen', grid);
  assert.ok(wide && 'shape' in wide, 'widen produced nothing');
  assert.equal(wide.shape, 'rect', 'widening a round table left it round, which is just grow');
  assert.equal(wide.w, two.w + grid, 'widen did not step by the snap grid');

  const grown = reshape(two, 'grow', grid);
  assert.ok(grown && 'seats' in grown, 'grow produced nothing for a two-top');
  assert.equal(grown.seats, two.seats + 2, 'grow did not add two seats');
  assert.deepEqual(
    { w: grown.w, h: grown.h, shape: grown.shape },
    protoFor(two.seats + 2),
    'grow and protoFor disagree about the footprint, so seats and geometry can drift',
  );

  // And the arguments survive the mutation they were computed for.
  must(updateTable(s, grown, 'human'), 'growing a two-top to a four-top');
  assert.equal(two.seats, 4, 'the grow did not take');
  assert.deepEqual([two.w, two.h], [protoFor(4).w, protoFor(4).h], 'the grown table kept its old footprint');

  // Grow is REFUSED on most of the seeded room, exactly as rotate is, and that is
  // correct rather than broken: the room is packed to 915mm aisles, so a four-top going
  // to six eats the window aisle. The refusal names the nearest clear spot, so the pane
  // surfaces that sentence instead of treating the button as dead (§4).
  const big = reshape(four, 'grow', grid);
  assert.ok(big && 'seats' in big, 'grow produced nothing for a four-top');
  refused(updateTable(s, big, 'human'), 'growing a four-top into the window aisle', 'nearest clear spot');
}

{
  // Duplicate is addTable with `near`, which routes through findSpot. NEVER a raw offset:
  // a 1-cell gap is 125mm against a 915mm minimum, so an offset copy is born in conflict.
  const s = seedState();
  const src = s.plan.tables.find((t) => t.name === 'T1')!;
  const before = errorsOnly(computeConflicts(s, 'design')).length;
  const copy = must(addTable(s, { seats: src.seats, shape: src.shape, near: { x: src.x, y: src.y } }, 'human'), 'duplicating a table');
  assert.ok(copy, 'duplicate returned no table');
  assert.ok(copy.x !== src.x || copy.y !== src.y, 'the duplicate landed on top of its original');
  assert.equal(
    errorsOnly(computeConflicts(s, 'design')).length,
    before,
    'the duplicate raised a layout error, so it was placed by offset rather than by findSpot',
  );

  // An explicit coordinate still REFUSES rather than quietly relocating (§4).
  refused(addTable(s, { seats: 2, x: src.x, y: src.y }, 'agent'), 'placing a table on top of another', 'nearest clear spot');
}

// --- apply_layout_template: the room the demo opens on ------------------------

{
  const s = seedState();
  const out = must(applyLayoutTemplate(s, { template: 'bistro', covers: 60 }, 'agent'), 'laying out a 60-cover bistro')!;
  assert.equal(out.covers, 60, `the bistro template built ${out.covers} covers, not 60`);
  assert.equal(out.tables, 16, `the bistro template built ${out.tables} tables, not 16`);
  // §7: there is one room, and the template builds it. Geometry must match the seed.
  for (const seeded of floorPlan.tables) {
    const built = s.plan.tables.find((t) => t.name === seeded.name);
    assert.ok(built, `the bistro template is missing ${seeded.name}`);
    assert.deepEqual(
      [built.x, built.y, built.w, built.h, built.shape, built.seats],
      [seeded.x, seeded.y, seeded.w, seeded.h, seeded.shape, seeded.seats],
      `${seeded.name} came out of the template in a different place`,
    );
  }
  assert.deepEqual(computeConflicts(s, 'design'), [], 'the bistro template builds a room with conflicts');
  assert.ok(s.plan.tables.every((t) => t.provenance === 'agent'), 'template tables are not stamped agent');
}

for (const template of ['banquet', 'communal'] as const) {
  const s = seedState();
  const out = must(applyLayoutTemplate(s, { template, covers: 48 }, 'agent'), `laying out a ${template} room`)!;
  assert.ok(out.covers >= 40 && out.covers <= 48, `${template} asked for 48 covers and built ${out.covers}`);
  // Sections are geographic bands, so a mixed-size template can leave one server heavy.
  // That is a balance WARNING for the agent to fix with assign_section (§9, 0:40), not a
  // broken room — but the geometry has to be clean.
  const errors = computeConflicts(s, 'design').filter((c) => c.severity === 'error');
  assert.deepEqual(errors, [], `${template} builds a room with conflicts: ${errors[0]?.message}`);
  const assigned = s.plan.sections.flatMap((x) => x.tableIds).sort();
  assert.deepEqual(assigned, s.plan.tables.map((t) => t.id).sort(), `${template} leaves tables outside every section`);
}

{
  // Never moves a pinned table (§4).
  const s = seedState();
  const keep = s.plan.tables[3];
  const where = { x: keep.x, y: keep.y };
  must(setPin(s, { targetId: keep.id }, 'human'), 'pinning before a re-layout');
  const out = must(applyLayoutTemplate(s, { template: 'banquet', covers: 40 }, 'agent'), 'laying out around a pin')!;
  const still = s.plan.tables.find((t) => t.id === keep.id);
  assert.ok(still, 'the template deleted a pinned table');
  assert.deepEqual({ x: still.x, y: still.y }, where, 'the template moved a pinned table');
  assert.ok(out.tables > 1, 'the re-layout built nothing around the pin');
  assert.ok(
    !computeConflicts(s, 'design').some((c) => c.severity === 'error'),
    'the re-layout collided with the pinned table',
  );
}

// --- Seating, including the thing only the agent can do -----------------------

{
  // §9, 1:35: a six-top walks in, nothing free seats six, T3+T4 go together.
  const s = seedState();
  s.shift.clock = 90;
  const six = must(addToWaitlist(s, { name: 'Okonkwo', size: 6 }, 'human'), 'adding a six-top walk-in')!;
  refused(seatParty(s, { waitId: six.id, tableIds: ['T1'] }, 'agent'), 'a six-top on a two-top', 'seats 2');
  refused(seatParty(s, { waitId: six.id, tableIds: ['T3', 'T12'] }, 'agent'), 'combining tables at opposite ends', 'near');
  const party = must(seatParty(s, { waitId: six.id, tableIds: ['T3', 'T4'] }, 'agent'), 'combining T3 and T4')!;
  assert.equal(party.tableId, 'T3', 'the combination has no primary table');
  assert.deepEqual(party.joinedIds, ['T4'], 'the second table was not joined');
  assert.equal(party.provenance, 'agent', 'an agent seating is not stamped agent');
  assert.ok(!s.waitlist.some((w) => w.id === six.id), 'the party is still on the waitlist');
  assert.deepEqual(computeConflicts(s, 'service'), [], 'a legal combination raised a conflict');

  // A joined table is not free, and clearing gives both of them back.
  refused(seatParty(s, { tableIds: ['T4'], name: 'Nobody', size: 2 }, 'agent'), 'seating on a joined table', 'Okonkwo');
  must(clearTable(s, { tableId: 'T4' }, 'human'), 'clearing by the joined table');
  must(seatParty(s, { tableIds: ['T4'], name: 'Later', size: 2 }, 'human'), 'seating once the combination broke up');
}

{
  const s = seedState();
  s.shift.clock = 60;
  const res = s.reservations[0];
  must(seatParty(s, { reservationId: res.id, tableIds: ['T2'] }, 'agent'), 'seating a reservation');
  assert.equal(res.status, 'seated', 'the reservation was not marked seated');
  refused(seatParty(s, { reservationId: res.id, tableIds: ['T3'] }, 'agent'), 'seating the same booking twice', 'already');

  const party = s.parties.find((p) => p.id === `p-${res.id}`)!;
  must(moveParty(s, { partyId: party.id, tableIds: ['T7'] }, 'agent'), 'moving a party');
  assert.equal(party.tableId, 'T7', 'the party did not move');
  must(seatParty(s, { tableIds: ['T2'], name: 'Walk-up', size: 2 }, 'human'), 'the vacated table is free again');
}

// --- Tickets ------------------------------------------------------------------

{
  const s = peak();
  const table = s.parties.find((p) => p.course === 'seated' || p.course === 'drinks')?.tableId
    ?? occupiedTable(s);
  const party = s.parties.find((p) => p.tableId === table)!;
  const already = s.tickets.filter((t) => t.partyId === party.id).map((t) => t.course);
  const course = (['dessert', 'mains', 'apps'] as const).find((c) => !already.includes(c))!;

  const dish = s.menu.find((m) => m.course === course)!;
  refused(fireCourse(s, { tableId: table, course, items: [{ menuItemId: dish.id, qty: 999 }] }, 'agent'), `ordering 999 of the ${dish.name}`, '1 to 12');
  refused(fireCourse(s, { tableId: table, course, items: [] }, 'agent'), 'firing an empty order');
  const wrongCourse = s.menu.find((m) => m.course !== course)!;
  refused(fireCourse(s, { tableId: table, course, items: [{ menuItemId: wrongCourse.id, qty: 1 }] }, 'agent'), 'ordering off the wrong course', wrongCourse.course);
  const off = s.menu.find((m) => m.course === course)!;
  off.is86d = true;
  refused(fireCourse(s, { tableId: table, course, items: [{ menuItemId: off.id, qty: 1 }] }, 'agent'), "ordering an 86'd dish", "86'd");
  off.is86d = false;

  const picks = s.menu.filter((m) => m.course === course).slice(0, 2);
  const ticket = must(fireCourse(s, { tableId: table, course, items: picks.map((m) => ({ menuItemId: m.id, qty: 2 })) }, 'agent'), 'ringing in a real order')!;
  assert.equal(ticket.items.length, picks.length, 'the order lost a line');
  assert.equal(ticket.provenance, 'agent', 'an agent-fired ticket is not stamped agent');
  assert.ok(ticket.items.every((i) => i.status === 'queued' && i.startedAt === null), 'a fired ticket started cooking before the kitchen picked it up');
  refused(fireCourse(s, { tableId: table, course }, 'agent'), 'firing the same course twice', 'already');

  // The simulation must not fire it a second time when the party reaches that course.
  let after = s;
  for (let i = 0; i < 60; i++) after = tick(after);
  const ids = after.tickets.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'the simulation fired a course the agent had already rung in');
}

{
  const s = peak();
  const open = s.tickets.find((t) => t.items.some((i) => i.status === 'queued'))
    ?? s.tickets.find((t) => t.items.some((i) => i.status !== 'served'))!;
  const wasDue = open.dueAt;
  must(retimeTicket(s, { ticketId: open.id, byMinutes: -8 }, 'agent'), 'pulling a ticket forward');
  assert.equal(open.dueAt, wasDue - 8, 'the due time did not move');
  assert.ok(open.firedAt >= 0 && open.firedAt <= s.shift.clock + 120, 'the fire time went somewhere impossible');
  refused(retimeTicket(s, { ticketId: open.id, byMinutes: 900 }, 'agent'), 'pushing a ticket into next week');
}

{
  // §9, 1:55: salmon is 86'd, and the tickets carrying it have to be fixable.
  const s = peak();
  const salmon = s.menu.find((m) => m.id === 'm-salmon')!;
  const halibut = s.menu.find((m) => m.id === 'm-halibut')!;
  const carrying = s.tickets.filter((t) => t.items.some((i) => i.menuItemId === salmon.id && i.status !== 'served'));
  const out = must(setItem86(s, { menuItemId: 'Grilled Salmon' }, 'agent'), "86'ing the salmon by name")!;
  assert.ok(salmon.is86d, 'the 86 did not stick');
  assert.deepEqual(out.tickets.sort(), carrying.map((t) => t.id).sort(), 'the 86 did not report the tickets carrying it');
  refused(setItem86(s, { menuItemId: 'm-salmon' }, 'agent'), "86'ing it twice", 'already');

  const queued = carrying.find((t) => t.items.some((i) => i.menuItemId === salmon.id && i.status === 'queued'));
  if (queued) {
    assert.ok(types(s).has('ticket-86'), "an 86'd item on an open ticket raises nothing");
    must(swapTicketItem(s, { ticketId: queued.id, menuItemId: salmon.id, toMenuItemId: halibut.id }, 'agent'), 'swapping salmon for halibut');
    assert.ok(!queued.items.some((i) => i.menuItemId === salmon.id), 'the salmon is still on the ticket');
    assert.equal(queued.dueAt, queued.firedAt + Math.max(...queued.items.map((i) => s.menu.find((m) => m.id === i.menuItemId)!.cookMinutes)) + 1, 'the due time was not recomputed after the swap');
  }
  const cooking = s.tickets.find((t) => t.items.some((i) => i.status === 'cooking'))!;
  const onTheStove = cooking.items.find((i) => i.status === 'cooking')!;
  refused(swapTicketItem(s, { ticketId: cooking.id, menuItemId: onTheStove.menuItemId }, 'agent'), 'swapping something already on the stove', 'cooking');
}

// --- Service notes -------------------------------------------------------------

{
  const s = peak();
  const note = s.notes.find((n) => n.status === 'open')!;
  must(resolveNote(s, { noteId: note.id, response: 'Pulled their mains forward eight minutes.' }, 'agent'), 'closing a note');
  assert.equal(note.status, 'resolved', 'the note is still open');
  refused(resolveNote(s, { noteId: note.id, response: 'again' }, 'agent'), 'closing a note twice', 'already');
  const long = resolveNote(s, { noteId: s.notes[1].id, response: 'x'.repeat(500) }, 'agent');
  must(long, 'closing a note with a long response');
  assert.ok((s.notes[1].response ?? '').length <= 240, 'a tool wrote 500 characters into state');
}

// --- Undo: the board goes back, the clock does not (§2, rules 2 and 3) ---------

{
  const start = peak();
  assert.ok(!('shift' in (snapshot(start) as Record<string, unknown>)), 'a snapshot carries the clock');

  // The mutation path, exactly as store.ts runs it.
  const history: ReturnType<typeof snapshot>[] = [];
  let s = start;
  const run = <T>(fn: (draft: SousState) => Result<T>) => {
    const before = snapshot(s);
    const draft = structuredClone(s);
    const r = fn(draft);
    if (!r.ok) return r;
    history.push(before);
    s = draft;
    return r;
  };

  const table = emptyTable(s);
  must(run((d) => seatParty(d, { tableIds: [table], name: 'Undoable', size: 2 }, 'agent')), 'seating for the undo test');
  const seatedAt = s.parties.find((p) => p.name === 'Undoable')!.seatedAt;
  assert.equal(history.length, 1, 'the mutation did not snapshot');

  // THE TICK PATH. Ticks must not push snapshots — this is the single most important
  // line in SOUS_PLAN.md §2, and at 60x a demo would otherwise roll the stack over.
  for (let i = 0; i < 200; i++) s = tick(s);
  assert.equal(history.length, 1, `200 ticks pushed ${history.length - 1} snapshots onto the undo stack`);
  const movedOn = s.shift.clock;
  assert.ok(movedOn > start.shift.clock, 'the clock did not run during the test');

  const back = restore(history.pop()!, s);
  assert.equal(back.shift.clock, movedOn, 'undo travelled back in time');
  assert.equal(back.shift.seed, start.shift.seed, 'undo lost the seed');
  assert.ok(!back.parties.some((p) => p.name === 'Undoable'), 'undo left the seating in place');
  // Absolute stamps mean the restored board recomputes correctly against the new clock.
  for (const p of back.parties.filter((x) => x.course !== 'departed')) {
    assert.ok(p.seatedAt <= back.shift.clock, `${p.name} came back from undo seated in the future`);
    assert.ok(back.shift.clock - p.courseAt >= 0, `${p.name} came back with a stale countdown`);
  }
  assert.ok(seatedAt <= movedOn, 'the undone party was stamped in the future');

  // Redo is the same step the other way, and it is cheap to prove it round-trips.
  const forward = restore(snapshot(s), back);
  assert.equal(forward.shift.clock, back.shift.clock, 'redo moved the clock');
  assert.ok(forward.parties.some((p) => p.name === 'Undoable'), 'redo lost the seating');
}

console.log(
  `mutations ok — 15 mutations, ${new Set(fired).size} conflict rules all firing, ` +
    'refusals never write, pins refuse both actors, only humans unpin, ' +
    'undo rewinds the board and not the clock. Design edits refuse mid-service, and the six quick actions compute legal arguments.',
);

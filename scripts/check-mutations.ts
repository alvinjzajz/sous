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
  addTable, addToWaitlist, applyLayoutTemplate, applySavedLayout, assignSection,
  clearTable, findSpot, fireCourse, moveParty, removeTable, reshape, resolveNote,
  restore, retimeTicket, seatParty, setItem86, setPin, snapshot, swapTicketItem,
  updateTable,
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
    ['updateTable on a pinned table', (s) => updateTable(s, { tableId: pinnedTable, seats: 8 }, 'agent')],
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

  // Raw coordinates that do not work are HONOURED and reported, with somewhere that
  // does on the end of the sentence (§4, mitigation 3). Placement stopped refusing when
  // drag-and-drop landed: a person moving a table must never be fought by the grid.
  const onTop = s.plan.tables[1];
  const stacked = addTable(s, { seats: 2, x: onTop.x, y: onTop.y }, 'agent');
  must(stacked, 'placing a table on top of another');
  assert.ok(/overlaps/.test(say(stacked)), `stacking says nothing about the overlap: "${say(stacked)}"`);
  assert.ok(/x \d+, y \d+/.test(say(stacked)), `the report offers no alternative spot: "${say(stacked)}"`);

  refused(addTable(s, { seats: 4, name: 'T1' }, 'agent'), 'reusing a table name', 'already');
  refused(addTable(s, { seats: 0 }, 'agent'), 'a table with no seats');
}

{
  // The quick actions are all updateTable underneath (§4). Geometry lands whatever it
  // costs, and what it costs comes back on the sentence.
  const s = seedState();
  const round = s.plan.tables.find((t) => t.shape === 'round' && t.w > 8)!;
  must(updateTable(s, { tableId: round.id, w: 8 }, 'human'), 'shrinking a round table');
  assert.equal(round.w, round.h, 'a round table stopped being square');
  assert.equal(round.provenance, 'human', 'the human who moved it does not own it');
  const eaten = updateTable(s, { tableId: round.id, w: 24 }, 'human');
  must(eaten, 'growing a table into the aisle');
  assert.ok(/aisle/.test(say(eaten)), `eating an aisle says nothing about it: "${say(eaten)}"`);
  assert.equal(round.w, 24, 'the grow did not take');
  // ...and the table that now blocks an aisle cannot be pinned down.
  refused(setPin(s, { targetId: round.id }, 'human'), 'pinning a table that closes an aisle', 'aisle');
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
  // The four reshape buttons are arguments to updateTable and nothing else. They change
  // the FOOTPRINT ONLY: seats are set by hand on the stepper beside them, because
  // deriving covers from size silently rewrote the room's capacity. null is a DISABLED
  // button, never a dead one (SOUS_PLAN.md §4).
  const s = seedState();
  const grid = s.plan.gridSize;
  const round = s.plan.tables.find((t) => t.shape === 'round')!;
  const rect = s.plan.tables.find((t) => t.shape === 'rect')!;

  assert.equal(reshape(round, 'rotate', grid), null, 'rotate is live on a round table, where it is a no-op');
  assert.ok(reshape(rect, 'rotate', grid), 'rotate is disabled on a rect table, where it is the whole point');
  assert.equal(reshape({ ...rect, w: 60 }, 'grow', grid), null, 'grow ran past the maximum side');
  assert.equal(reshape({ ...rect, w: 4, h: 4 }, 'shrink', grid), null, 'shrink ran past the minimum side');

  const grown = reshape(round, 'grow', grid)!;
  assert.deepEqual([grown.w, grown.h], [round.w + grid, round.w + grid], 'a round table did not grow on both axes');
  assert.ok(!('seats' in grown), 'grow changed the seat count, which is now set by hand');

  const wide = reshape(round, 'widen', grid);
  assert.ok(wide && 'shape' in wide, 'widen produced nothing');
  assert.equal(wide.shape, 'rect', 'widening a round table left it round, which is just grow');
  assert.equal(wide.w, round.w + grid, 'widen did not step by the snap grid');

  // The arguments survive the mutation they were computed for, and the seat count is
  // exactly what it was before.
  const seatsBefore = round.seats;
  must(updateTable(s, grown, 'human'), 'growing a round table');
  assert.deepEqual([round.w, round.h], [grown.w, grown.h], 'the grow did not take');
  assert.equal(round.seats, seatsBefore, 'growing a table changed how many people sit at it');

  // Seats are their own control, and the one service rule on them still holds.
  must(updateTable(s, { tableId: round.id, seats: 6 }, 'human'), 'setting the seat count by hand');
  assert.equal(round.seats, 6, 'the seat count did not take');
  assert.deepEqual([round.w, round.h], [grown.w, grown.h], 'setting seats moved the footprint');
  refused(updateTable(s, { tableId: round.id, seats: 0 }, 'human'), 'a table with no seats');
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

  // An explicit coordinate is HONOURED, and the overlap it causes comes back on the
  // result so the agent can self-correct (SOUS_PLAN.md §4, mitigation 3). This is the
  // rule the drag needs: a person moving a table must never be fought by the grid.
  const onTop = must(addTable(s, { seats: 2, x: src.x, y: src.y }, 'agent'), 'placing a table on top of another')!;
  assert.equal(onTop.x, src.x, 'an explicit coordinate was quietly relocated');
  assert.ok(
    errorsOnly(computeConflicts(s, 'design')).some((c) => c.type === 'overlap'),
    'stacking two tables raised no overlap conflict',
  );
}

// --- renaming frees the old name ----------------------------------------------

{
  // Reported bug: rename a table, then try to give another table the old name, and it
  // was refused as already taken. findTable matches ids AS WELL AS names, which is right
  // for a lookup and wrong for a uniqueness test, and every seeded table has id === name
  // - so the renamed table's leftover id kept its old name reserved for ever.
  const s = seedState();
  must(updateTable(s, { tableId: 'T1', name: 'Window' }, 'human'), 'renaming T1 to Window');
  must(updateTable(s, { tableId: 'T2', name: 'T1' }, 'human'), 'giving another table the freed name');
  assert.equal(s.plan.tables.find((t) => t.id === 'T2')?.name, 'T1', 'the second rename did not take');

  // The string "T1" is now genuinely ambiguous: one table is NAMED T1, another still has
  // the ID T1. Ids win, because they are unique by construction and names are user-typed.
  must(updateTable(s, { tableId: 'T1', seats: 6 }, 'human'), 'addressing T1 by id');
  assert.equal(s.plan.tables.find((t) => t.id === 'T1')?.seats, 6, 'a name shadowed the id it collides with');
  assert.notEqual(s.plan.tables.find((t) => t.id === 'T2')?.seats, 6, 'the wrong table was resized');

  // Automatic naming was broken by the same conflation: nextTableName offers a freed
  // name and the clash check then refused its own suggestion.
  const added = must(addTable(s, { seats: 2, anchor: 'centre' }, 'human'), 'adding an auto-named table after a rename');
  assert.ok(added, 'the add returned no table');
  assert.equal(
    s.plan.tables.filter((t) => t.name === added.name).length, 1,
    `the auto-named table duplicated the name ${added.name}`,
  );

  // A REAL clash still refuses, both ways round.
  refused(updateTable(s, { tableId: 'T3', name: 'T4' }, 'human'), 'taking a name another table still uses', 'already');
  refused(addTable(s, { seats: 2, name: 'Window' }, 'human'), 'adding a table under a name in use', 'already');
  // ...and a table may always be renamed to what it is already called.
  must(updateTable(s, { tableId: 'T3', name: 'T3' }, 'human'), 'renaming a table to its own name');
}

// --- placement reports, pinning gates -----------------------------------------

{
  // The model that replaced refuse-on-conflict: put a table anywhere, and PIN only what
  // is actually clear. Pinning is the commitment, so pinning is where legality lives.
  const s = seedState();
  const [a, b] = [s.plan.tables[0], s.plan.tables[1]];
  const moved = must(updateTable(s, { tableId: a.id, x: b.x, y: b.y }, 'human'), 'dragging a table on top of another');
  assert.ok(moved, 'the move returned no table');
  assert.equal(a.x, b.x, 'the move was refused or relocated instead of honoured');
  assert.ok(say(updateTable(s, { tableId: a.id, x: b.x, y: b.y }, 'human')).includes('overlap'),
    'a stacked table does not say so on the result');

  refused(setPin(s, { targetId: a.id }, 'human'), 'pinning a table that is on top of another', 'overlap');
  assert.equal(a.pinned, false, 'the refused pin pinned it anyway');

  // Move it clear and the same pin is fine.
  must(updateTable(s, { tableId: a.id, x: a.x, y: a.y + 0 }, 'human'), 'a no-op move');
  const spot = findSpot(s, a, { x: a.x, y: a.y })!;
  must(updateTable(s, { tableId: a.id, x: spot.x, y: spot.y }, 'human'), 'moving it to the nearest clear spot');
  must(setPin(s, { targetId: a.id }, 'human'), 'pinning a table that is clear');
  assert.equal(a.pinned, true, 'the pin did not take');

  // A PINNED table still refuses to move, for anyone. That rule did not change.
  refused(updateTable(s, { tableId: a.id, x: 40, y: 40 }, 'agent'), 'moving a pinned table', 'pinned');
}

{
  // Pinning an OCCUPIED table pins the party, and "don't move these people" is about the
  // people, not about where the table sits - so geometry does not gate it (CLAUDE.md #9).
  const s = peak();
  const held = occupiedTable(s);
  const t = s.plan.tables.find((x) => x.name === held || x.id === held)!;
  s.shift.mode = 'design';
  const other = s.plan.tables.find((x) => x.id !== t.id)!;
  must(updateTable(s, { tableId: t.id, x: other.x, y: other.y }, 'human'), 'moving an occupied table onto another');
  must(setPin(s, { targetId: t.id }, 'human'), 'pinning a party at a table that overlaps');
}

// --- saved layouts ------------------------------------------------------------

{
  // applySavedLayout is the load half of the localStorage layouts list. The store itself
  // is browser-only, so the check exercises the mutation against a plan it holds directly.
  const s = seedState();
  const saved = structuredClone(s.plan);
  must(removeTable(s, { tableId: 'T5' }, 'human'), 'clearing a table before saving');
  must(removeTable(s, { tableId: 'T7' }, 'human'), 'clearing another');
  must(setPin(s, { targetId: 'T1' }, 'human'), 'pinning a table before the load');

  const out = must(applySavedLayout(s, { name: 'saturday', plan: saved }, 'human'), 'loading a saved layout')!;
  assert.equal(out.tables, saved.tables.length, 'the loaded room has the wrong table count');
  assert.ok(s.plan.tables.some((t) => t.name === 'T5'), 'the load did not bring the room back');
  assert.equal(s.plan.tables.find((t) => t.name === 'T1')?.pinned, true, 'the load walked over a pin');
  assert.equal(
    s.plan.tables.filter((t) => t.name === 'T1').length, 1,
    'the kept pin was duplicated by the load',
  );
  for (const t of s.plan.tables) {
    assert.ok(
      s.plan.sections.some((x) => x.tableIds.includes(t.id)),
      `${t.name} came back from a load with no section`,
    );
  }

  const busy = peak();
  refused(applySavedLayout(busy, { name: 'saturday', plan: saved }, 'agent'), 'loading a layout mid-service', 'people at tables');
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
  `mutations ok — 16 mutations, ${new Set(fired).size} conflict rules all firing, ` +
    'refusals never write, pins refuse both actors, only humans unpin, ' +
    'undo rewinds the board and not the clock. Design edits refuse mid-service, placement reports instead of refusing, and only a table that is clear can be pinned.',
);

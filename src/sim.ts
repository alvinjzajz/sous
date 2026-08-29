// The simulation engine (SOUS_PLAN.md §8, day 2). Pure, headless, no React.
//
// tick(state) -> state advances the shift by ONE minute. It is the only path that
// moves the clock, and it never touches the undo stack (§2, rule 1). Mutations live
// on the other path and land on day 3.
//
// Determinism: every random draw is seeded on (shift.seed, some stable key) rather
// than on a carried cursor, so tick stays pure and the same seed replays the same
// night. advanceTo(seedState(), 135) always produces the same 7:15 PM room.
import type {
  CourseStage, MenuCourse, MenuItem, Party, SousState, Table, Ticket, TicketItem,
  TicketItemStatus, WaitEntry,
} from './types.ts';

// --- Tunables ----------------------------------------------------------------
// ponytail: flat per-stage constants, no distribution. If turn times read too
// uniform on camera, jitter each by ±20% off hash(party.id) — same call sites.

/** Minutes between sitting down and the drinks order going in. */
const ORDER_MIN = 4;
/** Minutes between the last item plating and the course reaching the table. */
const RUNNER_MIN = 1;
/** Minutes a party lingers over a course after it lands, before the next is fired. */
const DWELL: Record<MenuCourse | 'check', number> = {
  drinks: 9, apps: 12, mains: 22, dessert: 10, check: 7,
};
/** Fraction of a party that orders this course. Everyone drinks and everyone eats. */
const SHARE: Record<MenuCourse, number> = { drinks: 1, apps: 0.6, mains: 1, dessert: 0.45 };
/** Rough minutes still to run, by stage — drives wait quotes. */
const REMAINING: Record<CourseStage, number> = {
  seated: 88, drinks: 74, apps: 56, mains: 30, dessert: 15, check: 5, departed: 0,
};
/**
 * Minutes a party stands at the host stand before the house finds them a table.
 * Bigger parties take longer to place. This is what leaves someone waiting for the
 * agent to seat instantly (§9, 1:15) — and why the room still fills without it.
 */
const hostLag = (size: number) => 4 + size;
/** Last minute the room takes walk-ins, and the most that may stand at the door. */
const WALKIN_UNTIL = 255; // 9:15 PM
const WAITLIST_CAP = 12;
/** Nobody is seated after this — it is the "last seat 9:45" the left rail advertises. */
export const LAST_SEAT = 285; // 9:45 PM
/**
 * Hard ceiling, so `advanceTo` always terminates even if a tool wedges the room.
 * It is NOT the end of service: service ends when the last table leaves (`serviceOver`),
 * which on the seeded night is somewhere around 11 PM.
 */
export const SERVICE_END = 420; // midnight

const NEXT: Record<CourseStage, CourseStage> = {
  seated: 'drinks', drinks: 'apps', apps: 'mains', mains: 'dessert',
  dessert: 'check', check: 'departed', departed: 'departed',
};

const WALKIN_NAMES = [
  'Bergstrom', 'Castellanos', 'Duong', 'Eriksen', 'Fontaine', 'Gallagher', 'Haddad',
  'Ibarra', 'Jankowski', 'Kimura', 'Larsen', 'Moreau', 'Nwachukwu', 'Oyelaran',
  'Petrov', 'Quintero', 'Rasmussen', 'Sandoval', 'Tanaka', 'Ustinov', 'Villanueva',
  'Weatherby', 'Yilmaz', 'Zamora',
];
/** Allergen words the host stand recognises in a booking note. */
const ALLERGENS = ['shellfish', 'nuts', 'dairy', 'gluten', 'soy'];
/** Booking notes that mark a table you do not want to get wrong. */
const VIP_WORDS = ['anniversary', 'birthday', 'regular', 'vip'];

// --- Determinism -------------------------------------------------------------

/** mulberry32 — five lines, and the seed is exposed so a judge can replay (§2). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so a string key can seed an RNG. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- Derived time ------------------------------------------------------------
// Nothing below is stored on state. Everything recomputes against the clock on
// every call, which is what stops undo resurrecting a stale countdown (§2, rule 3).

const byId = (menu: MenuItem[]) => new Map(menu.map((m) => [m.id, m]));

/** Shift-minute the last item on this ticket leaves the pass, or null if one has not started. */
export function ticketPlatedAt(t: Ticket, menu: Map<string, MenuItem>): number | null {
  let last = -Infinity;
  for (const it of t.items) {
    if (it.startedAt === null) return null;
    last = Math.max(last, it.startedAt + (menu.get(it.menuItemId)?.cookMinutes ?? 0));
  }
  return last === -Infinity ? null : last;
}

/** Shift-minute the course reaches the table. A course lands together or not at all. */
export function ticketServedAt(t: Ticket, menu: Map<string, MenuItem>): number | null {
  const plated = ticketPlatedAt(t, menu);
  return plated === null ? null : plated + RUNNER_MIN;
}

/**
 * Items in a given state at each station. One order line is one slot, whatever the qty.
 * `cooking` is the station's live load against its concurrency; `queued` is its backlog.
 */
export function stationLoad(
  s: SousState,
  status: TicketItemStatus = 'cooking',
): Record<string, number> {
  const menu = byId(s.menu);
  const load: Record<string, number> = {};
  for (const st of s.plan.stations) load[st.type] = 0;
  for (const t of s.tickets) {
    if (t.firedAt > s.shift.clock) continue; // re-timed into the future, not waiting yet
    for (const it of t.items) {
      if (it.status !== status) continue;
      const type = menu.get(it.menuItemId)?.stationType;
      if (type) load[type] = (load[type] ?? 0) + 1;
    }
  }
  return load;
}

/** Tables with nobody sitting at them right now. */
export function freeTables(s: SousState): Table[] {
  const taken = new Set(
    s.parties.filter((p) => p.course !== 'departed' && p.tableId).map((p) => p.tableId),
  );
  return s.plan.tables.filter((t) => !taken.has(t.id));
}

/** Covers currently seated in each section, for load balancing. */
export function sectionCovers(s: SousState): Record<string, number> {
  const cov: Record<string, number> = {};
  for (const sec of s.plan.sections) cov[sec.id] = 0;
  for (const p of s.parties) {
    if (p.course === 'departed' || !p.tableId) continue;
    const sec = s.plan.sections.find((x) => x.tableIds.includes(p.tableId as string));
    if (sec) cov[sec.id] += p.size;
  }
  return cov;
}

/**
 * The smallest free table that fits, breaking ties toward the quieter section.
 * The house only ever seats at ONE table — combining T3+T4 is something the agent
 * can do and the simulation cannot, which is the 1:35 beat in the demo (§9).
 */
export function pickTable(s: SousState, size: number): Table | null {
  const cov = sectionCovers(s);
  return (
    freeTables(s)
      .filter((t) => t.seats >= size)
      .sort(
        (a, b) =>
          a.seats - b.seats ||
          (cov[a.sectionId] ?? 0) - (cov[b.sectionId] ?? 0) ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}

/** Minutes a party of `size` should be quoted, from free tables and projected departures. */
export function quoteWait(s: SousState, size: number): number {
  if (pickTable(s, size)) return 0;
  const seated = new Map(
    s.parties
      .filter((p) => p.course !== 'departed' && p.tableId)
      .map((p) => [p.tableId as string, p]),
  );
  // ponytail: remaining time is a flat per-stage constant (REMAINING), not a projection
  // off the party's own in-flight tickets. Upgrade is to use ticketServedAt of the
  // current course where one exists — same function, one extra branch.
  const waits = s.plan.tables
    .filter((t) => t.seats >= size)
    .map((t) => {
      const p = seated.get(t.id);
      return p ? Math.max(0, REMAINING[p.course] - (s.shift.clock - p.courseAt)) : 0;
    });
  if (!waits.length) return 90;
  const ahead = s.waitlist.filter((w) => w.size >= size).length;
  return Math.max(5, Math.min(90, Math.round(Math.min(...waits) + 5 + ahead * 3)));
}

// --- Building blocks the day-3 mutations share --------------------------------

/**
 * What a party orders for one course. Deterministic on (seed, party, course).
 *
 * ponytail: orders are composed, never entered. Ceiling — nobody, human or agent, can
 * tell Sous what a table actually asked for; `swap_ticket_item` editing a line after the
 * fact is the only way in. Upgrade is an optional `items` argument on fireTicket that
 * falls back to this, which `fire_course` then takes as a parameter. Deliberate for the
 * hackathon (SOUS_PLAN.md §11); revisit before anyone runs a real service on this.
 */
export function compose(s: SousState, party: Party, course: MenuCourse): TicketItem[] {
  const rng = mulberry32(s.shift.seed ^ hash(`${party.id}:${course}`));
  // 86'd items are simply never ordered. Items already fired stay fired — that
  // collision is real, and set_item_86 is the tool that surfaces it (§9, 1:55).
  const pool = s.menu.filter((m) => m.course === course && !m.is86d);
  if (!pool.length) return [];
  const qty = new Map<string, number>();
  for (let i = 0; i < party.size; i++) {
    if (rng() > SHARE[course]) continue;
    const m = pool[Math.floor(rng() * pool.length)];
    qty.set(m.id, (qty.get(m.id) ?? 0) + 1);
  }
  return [...qty].map(([menuItemId, n]) => ({
    menuItemId, qty: n, status: 'queued' as const, startedAt: null,
  }));
}

/** Ring in a course for a party. Returns null when nobody at the table ordered it. */
export function fireTicket(
  s: SousState,
  party: Party,
  course: MenuCourse,
  provenance: Ticket['provenance'] = 'human',
): Ticket | null {
  const items = compose(s, party, course);
  if (!items.length) return null;
  const menu = byId(s.menu);
  const cook = Math.max(...items.map((i) => menu.get(i.menuItemId)?.cookMinutes ?? 0));
  return {
    id: `tk-${party.id}-${course}`,
    partyId: party.id,
    course,
    items,
    firedAt: s.shift.clock,
    dueAt: s.shift.clock + cook + RUNNER_MIN,
    provenance,
  };
}

/** Sit a party down. The one place a Party is born; tools and buttons both come here. */
export function seatAt(
  s: SousState,
  table: Table,
  init: { id: string; name: string; size: number; notes?: string; provenance?: Party['provenance'] },
): Party {
  const notes = init.notes ?? '';
  const lower = notes.toLowerCase();
  const party: Party = {
    id: init.id,
    name: init.name,
    size: init.size,
    tableId: table.id,
    seatedAt: s.shift.clock,
    course: 'seated',
    courseAt: s.shift.clock,
    notes,
    allergies: ALLERGENS.filter((a) => lower.includes(a)),
    vip: VIP_WORDS.some((w) => lower.includes(w)),
    pinned: false,
    provenance: init.provenance ?? 'human',
  };
  s.parties.push(party);
  return party;
}

// --- The tick ----------------------------------------------------------------

/** Walk-ins per minute. Thin at the doors, heavy through the 6:30-to-8:30 push. */
function walkinRate(clock: number): number {
  if (clock < 30) return 0; // 5:00-5:30, nobody
  if (clock < 90) return 0.04; // 5:30-6:30, early
  if (clock < 210) return 0.08; // 6:30-8:30, the push
  return 0.03; // 8:30 on, tailing off
}

/** Reservations come due; walk-ins turn up at the door. */
function arrivals(s: SousState): void {
  const clock = s.shift.clock;
  for (const r of s.reservations) {
    if (r.status === 'expected' && clock >= r.time) r.status = 'arrived';
  }

  if (clock > WALKIN_UNTIL || s.waitlist.length >= WAITLIST_CAP) return;
  const rng = mulberry32(s.shift.seed ^ Math.imul(clock, 0x9e3779b1));
  if (rng() >= walkinRate(clock)) return;

  const size = [2, 2, 2, 2, 3, 4, 4, 5, 6][Math.floor(rng() * 9)];
  const taken = new Set([...s.parties.map((p) => p.name), ...s.waitlist.map((w) => w.name)]);
  const from = Math.floor(rng() * WALKIN_NAMES.length);
  let name = `${WALKIN_NAMES[from]} party`;
  for (let k = 0; k < WALKIN_NAMES.length; k++) {
    const cand = WALKIN_NAMES[(from + k) % WALKIN_NAMES.length];
    if (!taken.has(cand)) {
      name = cand;
      break;
    }
  }
  const entry: WaitEntry = {
    id: `w-${clock}`, name, size, addedAt: clock, quotedMinutes: quoteWait(s, size),
  };
  s.waitlist.push(entry);
}

/**
 * Service is over when the last seating has passed and the room has emptied — not at
 * a fixed clock time. A restaurant closes when the last table leaves.
 */
export function serviceOver(s: SousState): boolean {
  if (s.shift.clock >= SERVICE_END) return true;
  if (s.shift.clock < LAST_SEAT) return false;
  if (s.parties.some((p) => p.course !== 'departed')) return false;
  return !s.tickets.some((t) => t.items.some((i) => i.status !== 'served'));
}

/** The host stand seats whoever it can, reservations before the door. */
function seatWaiting(s: SousState): void {
  if (s.shift.clock > LAST_SEAT) return; // the book is closed; nobody else sits tonight
  const arrived = s.reservations
    .filter((r) => r.status === 'arrived')
    .sort((a, b) => a.time - b.time);
  for (const r of arrived) {
    if (s.shift.clock < r.time + hostLag(r.size)) continue;
    const t = pickTable(s, r.size);
    if (!t) continue; // continue, not break: a two-top seats while a six waits
    seatAt(s, t, { id: `p-${r.id}`, name: r.name, size: r.size, notes: r.notes });
    r.status = 'seated';
  }
  for (const w of [...s.waitlist]) {
    if (s.shift.clock < w.addedAt + hostLag(w.size)) continue;
    const t = pickTable(s, w.size);
    if (!t) continue;
    seatAt(s, t, { id: `p-${w.id}`, name: w.name, size: w.size });
    s.waitlist.splice(s.waitlist.indexOf(w), 1);
  }
}

/** Everything on the stove that is done comes off, and finished courses go out. */
function completeItems(s: SousState): void {
  const clock = s.shift.clock;
  const menu = byId(s.menu);
  for (const t of s.tickets) {
    for (const it of t.items) {
      if (it.status !== 'cooking') continue;
      if (clock >= (it.startedAt ?? 0) + (menu.get(it.menuItemId)?.cookMinutes ?? 0)) {
        it.status = 'plated';
      }
    }
    const served = ticketServedAt(t, menu);
    if (served !== null && clock >= served) for (const it of t.items) it.status = 'served';
  }
}

/**
 * The kitchen picks up what it can. An item does not start cooking when its ticket is
 * fired — it starts when a slot frees at its station, which is why fire time and start
 * time are two different stamps (§8). One order line takes one slot, whatever the qty.
 */
function startItems(s: SousState): void {
  const clock = s.shift.clock;
  const menu = byId(s.menu);
  const load = stationLoad(s);
  const cap: Record<string, number> = {};
  for (const st of s.plan.stations) cap[st.type] = st.concurrency;

  // Whatever is due soonest gets the next slot. This is what makes retime_ticket bite.
  const queued = s.tickets
    .filter((t) => t.firedAt <= clock)
    .flatMap((t) => t.items.filter((i) => i.status === 'queued').map((i) => ({ t, i })))
    .sort(
      (a, b) =>
        a.t.dueAt - b.t.dueAt ||
        a.t.firedAt - b.t.firedAt ||
        a.t.id.localeCompare(b.t.id) ||
        a.i.menuItemId.localeCompare(b.i.menuItemId),
    );

  for (const { i } of queued) {
    const type = menu.get(i.menuItemId)?.stationType;
    if (!type) continue;
    if ((load[type] ?? 0) >= (cap[type] ?? 0)) continue;
    i.status = 'cooking';
    i.startedAt = clock;
    load[type] = (load[type] ?? 0) + 1;
  }
}

/** Move a party on, firing the next course. Skips a course nobody ordered. */
function advance(s: SousState, p: Party, to: CourseStage): void {
  p.course = to;
  p.courseAt = s.shift.clock;
  if (to === 'departed') {
    p.tableId = null;
    return;
  }
  if (to === 'check') return;
  const ticket = fireTicket(s, p, to as MenuCourse);
  if (ticket) s.tickets.push(ticket);
  else advance(s, p, NEXT[to]); // nobody ordered it, so there is nothing to wait for
}

/** Dwell timers. A party moves on once its course has landed and been eaten. */
function advanceParties(s: SousState): void {
  const clock = s.shift.clock;
  const menu = byId(s.menu);
  for (const p of s.parties) {
    if (p.course === 'departed') continue;
    if (p.course === 'seated') {
      if (clock >= p.courseAt + ORDER_MIN) advance(s, p, 'drinks');
      continue;
    }
    if (p.course === 'check') {
      if (clock >= p.courseAt + DWELL.check) advance(s, p, 'departed');
      continue;
    }
    const course = p.course as MenuCourse;
    const ticket = s.tickets.find((t) => t.partyId === p.id && t.course === course);
    // No ticket means a tool removed it; fall back to the stage stamp so nobody hangs.
    const served = ticket ? ticketServedAt(ticket, menu) : p.courseAt;
    if (served === null || clock < served + DWELL[course]) continue;
    advance(s, p, NEXT[course]);
  }
}

/** One shift-minute. Pure: clone in, clone out, no React, no undo snapshot (§2). */
export function tick(state: SousState): SousState {
  const s = structuredClone(state);
  if (serviceOver(s)) {
    s.shift.running = false; // last table has gone; the clock does not run all night
    return s;
  }
  s.shift.clock += 1;
  arrivals(s);
  seatWaiting(s);
  // Order matters: finish what is done, let servers ring in the next course, THEN let
  // the kitchen pick up whatever it has slots for. Starting before the new tickets exist
  // would leave every freshly fired course looking backed up for a minute.
  completeItems(s);
  advanceParties(s);
  startItems(s);
  return s;
}

/**
 * Run the shift forward to an absolute shift-minute. Never runs backwards, and stops
 * early once service is over — a stalled clock ends the loop rather than spinning it.
 */
export function advanceTo(state: SousState, minute: number): SousState {
  let s = state;
  while (s.shift.clock < minute) {
    const next = tick(s);
    if (next.shift.clock === s.shift.clock) return next;
    s = next;
  }
  return s;
}

export { DWELL, ORDER_MIN, REMAINING, RUNNER_MIN };

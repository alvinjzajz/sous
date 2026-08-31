# Sous

*Your second on the line.*

One restaurant, one screen, one dinner service. You and your agent design the room, then
run it together.

A submission for [the WebMCP Challenge](https://webmcp.devpost.com/). WebMCP lets a web
page register tools an AI agent can call directly, so the agent and the person are working
on the *same live page* rather than through an API.

**Status: in progress.** Days 1 to 4 of 6 are complete — domain model, seed scenario,
floor-plan renderer, the simulation engine, the mutation layer with its undo stack and
conflict engine, and the whole human interface: six detail panes, drag-and-drop layout,
design tools, saved floor plans, the waitlist and reservation book, and the agent activity
rail. **The WebMCP tool surface is still to come, so nothing below about tools describes
shipped code yet**; it describes what is being built.

Everything the tools will do, a person can already do, through the same functions. Every
button in the app calls one of the nineteen plain functions in `src/mutations.ts` via
`sous.run(fn, by)`, and a tool body is `sous.run(fn, 'agent')` and nothing else — which is
why a pin refusal cannot drift between the two surfaces. Pins, provenance, conflict
overrides, the design-mode gate and the activity rail are all real today.

**Two rules carry the collaboration, and both are enforced in one place:**

- **A pin says the rules do not get to move this.** Pins block everyone — a tool refuses a
  pinned table whoever asked — and **only a human may unpin**.
- **An override says this rule does not get to stop me.** A human can accept any conflict;
  the board stops raising it, and the pin gate honours that too. **Only a human may
  override, or put one back.**

Layout edits deliberately never refuse on geometry: a table goes where you drag it, and any
overlap or closed aisle comes back as a sentence and a mark on the floor. Pinning is the
commitment, so pinning is where legality is enforced.

## The idea

A single floor-plan canvas that is both the design surface and the live service board.

**Design mode** — the room is empty. You and the agent place tables, set capacities, cut
the floor into server sections. The agent can lay out a dining room from a sentence; you
drag anything you disagree with, and what you move, you own.

**Service mode** — the same canvas becomes the board. A shift clock runs. Reservations
arrive, parties progress through courses, tickets fire to stations, the grill backs up,
the salmon gets 86'd. The agent seats, re-times and re-balances while you override it.

Three things make this more than "agent drives the app":

- **Provenance.** Every table and party is stamped `human` or `agent`, and the canvas
  shows which.
- **Pins.** The human can pin anything, and the agent's tools refuse to touch it — and say
  so in their own descriptions. The agent may pin; only the human may unpin.
- **A live clock.** The board keeps moving while the agent works on it, which makes the
  negotiation between person and agent urgent rather than leisurely.

## Running it

```bash
npm install
npm run dev
```

| Script | What |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run check` | All three check scripts: seed consistency (seat totals, integer geometry, table overlap, 915 mm aisle clearance, section coverage, menu routing), a headless open-to-close shift, and the mutation path (every conflict rule fires, no refusal writes, pins refuse both actors, undo rewinds the board and not the clock) |
| `npm run build` | Type-check and production build |
| `npm run lint` | oxlint |

`npm run check` runs on plain `node` using native TypeScript type-stripping — no test
framework and no bundler, which is why relative imports carry explicit `.ts` extensions.

To use the agent side you need WebMCP enabled: Chrome with
`chrome://flags/#enable-webmcp-testing`, or ChatGPT's in-app browser.

## How it is built

React + Vite + TypeScript. **No backend, no database, no auth** — state lives in memory.
No chart, drag or state-management libraries. (`localStorage` autosave is planned, not yet
implemented.)

- `src/types.ts` — the domain model. All geometry is in **cells** (1 cell = 0.125 m),
  integers only. Timestamps are absolute shift-minutes; elapsed values are derived at
  render, never stored, which is what stops undo resurrecting a stale countdown.
- `src/seed.ts` — Saturday night at a neighbourhood bistro: 16 tables / 60 seats, four
  sections, six stations, a 22-item menu, 12 reservations totalling 38 covers. The shift
  starts **empty** at 5:00 PM; mid-service state is produced by replaying the reservation
  book against a seeded RNG, not from a hand-authored fixture, so the same seed replays the
  same evening.
- `src/FloorPlan.tsx` — the floor, as inline SVG rather than canvas. Every table is a real
  focusable `role="button"` node, so click handling, focus rings, keyboard navigation and
  screen-reader labels come free.
- `src/sim.ts` — the simulation engine. `tick(state) → state` is pure and React-free, so
  it runs headless. Parties advance on dwell timers; items do not start cooking when a
  ticket is fired but when a slot frees at their station, so fire time and start time are
  two different stamps. Service ends when the last table leaves, not at a fixed hour.
- `src/mutations.ts` — every mutation in the app, as plain functions. Buttons call these;
  the WebMCP tools will call the same ones, so a pin refusal cannot drift between the two
  surfaces. Each is `fn(draft, args, by) → Result`, and a refusal is a **value**, not a
  throw: the UI needs it to disable a button, and the tool wrapper turns the same sentence
  into an error the model can act on. Pins block everyone; only a human may unpin.
- `src/conflicts.ts` — `computeConflicts(state, scope)`, one function. The layout validator
  and the service board's alarm list are the same engine filtered, never two
  implementations, so every tool either creates conflicts or resolves them.
- `src/store.ts` — the two paths into state. The clock ticks straight through; only
  mutations snapshot for undo, and a snapshot never carries the clock — so undo rewinds the
  board without travelling back in time.
- `scripts/check-seed.ts`, `scripts/check-sim.ts`, `scripts/check-mutations.ts` — the checks
  above. The simulation check
  walks a whole shift a minute at a time and asserts, every minute, that nothing finishes
  before it starts, no station exceeds its concurrency, courses land together and never run
  backwards, and one party sits per table — then that the night resolves with the room
  empty. It also asserts `tick` is pure and that the same seed replays the same evening.

### On the pixel art

The floor is deliberately pixel-art while everything around it is clean and modern: the
room reads as a board, the instruments read as a tool. It is drawn with SVG patterns and
polygons with `shape-rendering: crispEdges`. The render grid is twice as fine as the domain
grid — one `scale(2)` applied once — so decoration can use half-cells while the geometry
underneath stays integer cells. Round tables are the exception in shape only: they are
midpoint-circle polygons quantised to whole cells, because a true circle at half-cell
resolution stops reading as pixel art. The canvas sizes itself to the stage on both axes,
so the room grows with the window and never scrolls. Accessibility is not traded for it.

### Accessibility

Tables, stations and the host stand are keyboard-traversable with visible focus and
descriptive labels; every edit, human or agent, is announced through a `role="log"` live
region, refusals included. Aisle clearance is a real domain constraint in the
conflict engine, checked against the ADA 2010 §403.5.1 accessible-route minimum of 915 mm.

## Security

No backend, no accounts, no PII, no money — which deletes most of the classic
vulnerability list and leaves two risks that genuinely apply: **indirect prompt injection**
(anything the agent reads is a potential instruction) and the fact that **the tool surface
is effectively an unauthenticated public API**.

The tool surface does not exist yet, so most of these are commitments the build is being
held to rather than properties you can audit in this tree today: tools returning user-typed
text will carry `untrustedContentHint`, and user strings will never reach a tool schema —
only author-controlled registries will.

**The pin rule is already real and already tested.** An agent may pin; only a human may
unpin, so a successful injection still cannot unprotect what a human protected. Agent-
supplied order lines are validated as untrusted input at the boundary — unknown ids, 86'd
dishes, course mismatches and unbounded quantities are all rejected by the executor rather
than left to schema validation — and every string a tool can write into state is length-
capped. `scripts/check-mutations.ts` asserts all of it, including that a refused mutation
never half-writes.

What *is* true of this tree today: no `dangerouslySetInnerHTML` or `innerHTML` anywhere, no
user-controlled `href`/`src`/`style`, no production source maps, no secrets (there is
nowhere to put one), and a clean `npm audit` over two runtime dependencies.

`window.__sous` is planned as a deliberate, documented exposure for testing and the Chrome
evals harness — read/write access to app state for any script on the page, acceptable for a
demo with no real data, and called out here so it reads as a decision rather than an
oversight when it lands.

## Licence

MIT — see [LICENSE](./LICENSE). The bundled Silkscreen and Instrument Sans fonts are SIL
Open Font License 1.1; see [NOTICE](./NOTICE).

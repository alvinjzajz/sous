# Sous

*Your second on the line.*

One restaurant, one screen, one dinner service. You and your agent design the room, then
run it together.

A submission for [the WebMCP Challenge](https://webmcp.devpost.com/). WebMCP lets a web
page register tools an AI agent can call directly, so the agent and the person are working
on the *same live page* rather than through an API.

**Status: feature-complete.** Domain model, seed scenario, floor-plan renderer, the
simulation engine, the mutation layer with its undo stack and conflict engine, the whole
human interface (seven detail panes, drag-and-drop layout, design tools, saved floor
plans, the waitlist and reservation book, the menu board, order entry, the agent activity
rail), the local autosave, and **all 30 WebMCP tools, registered and tested against
Chrome's native implementation**. What is left is deploy and the demo video.

**Your night is where you left it.** There is no backend, so the board autosaves to
`localStorage` and comes back on the next visit — the room, the clock, the parties, the
tickets and the pins. **Reset is the only thing that puts the seed scenario back**, and it
is in the transport row at the top of the floor.

Everything a tool can do, a person can do — and as of Day 6 that is literal rather than
aspirational. The three verbs the agent had and the person did not are all closed: 86'ing
a dish (the menu board), running a plated course to the table (Deliver, in the pass rail),
and choosing the dishes on an order rather than letting the kitchen compose it (the picker
beside Fire). Taking a booking runs the other way — it is the one thing the person can do
and the agent cannot, because the door takes bookings, not the agent.

Everything the tools do, a person can do too, through the same functions. Every button in
the app calls one of the twenty-one plain functions in `src/mutations.ts` via `sous.run(fn,
by)`, and **a tool body is `sous.run(fn, 'agent')` and nothing else** — which is why a pin
refusal cannot drift between the two surfaces. The refusal sentence a button shows is the
sentence the agent is handed.

Open the agent panel in the top left to see all 30 tools, what each one does, and whether
the browser has registered them.

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
| `npm run check` | All four check scripts: seed consistency (seat totals, integer geometry, table overlap, 915 mm aisle clearance, section coverage, menu routing), a headless open-to-close shift, the mutation path (every conflict rule fires, no refusal writes, pins refuse both actors, undo rewinds the board and not the clock), and the tool surface (Chrome's four character budgets, the 1.5 KB output ceiling, annotation accuracy, author-controlled enums, unescapable untrusted spans) |
| `npm run build` | Type-check and production build |
| `npm run lint` | oxlint |

`npm run check` runs on plain `node` using native TypeScript type-stripping — no test
framework and no bundler, which is why relative imports carry explicit `.ts` extensions.

To use the agent side you need WebMCP enabled: Chrome with
`chrome://flags/#enable-webmcp-testing`, or ChatGPT's in-app browser.

## How it is built

React + Vite + TypeScript. **No backend, no database, no auth** — state lives in memory.
No chart, drag or state-management libraries — and no MCP client library either; the
registration is about a hundred lines against the browser API.

- `src/types.ts` — the domain model. All geometry is in **cells** (1 cell = 0.125 m),
  integers only. Timestamps are absolute shift-minutes; elapsed values are derived at
  render, never stored, which is what stops undo resurrecting a stale countdown.
- `src/seed.ts` — Saturday night at a neighbourhood bistro: 16 tables / 60 seats, four
  sections, six stations, a 22-item menu, 12 reservations totalling 38 covers. The shift
  starts **empty** at 5:00 PM; mid-service state is produced by replaying the reservation
  book against a seeded RNG, not from a hand-authored fixture, so the same seed replays the
  same evening. The book is demand-generator scaffolding rather than part of the room, so
  it arrives on the first tick and **stays out entirely if you have taken bookings of your
  own** at the host stand — the same cooperative rule the auto-seater follows.
- `src/FloorPlan.tsx` — the floor, as inline SVG rather than canvas. Every table is a real
  focusable `role="button"` node, so click handling, focus rings, keyboard navigation and
  screen-reader labels come free.
- `src/tools.ts` — the 30 WebMCP tools, definitions and implementations in one file so a
  schema and its executor cannot drift apart. Every mutating body is `sous.run(fn,
  'agent')` and nothing else. Output is compact **text**, not JSON: the floor plan as JSON
  is 2196 bytes against Chrome's ~1.5 KB ceiling, and 648 as text. Any read whose length
  depends on how much a person has typed goes through `capLines()`, which drops rows until
  the result fits and says how many it dropped — silent truncation reads to a model as a
  board with less on it than there is.
- `src/webmcp.ts` — registration and the trust boundary. Registers once on mount with the
  implementations behind a ref, so tools never go stale and never re-register; both
  `document.modelContext` and `navigator.modelContext`, deduped, with `AbortController`
  cleanup. **A refusal comes back as an MCP result carrying `isError`, not a thrown
  error** — tested against Chrome's real implementation, where a throw reaches the agent
  as a generic `UnknownError` with the message stripped, which would have silently
  replaced every refusal sentence in the app.
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
  board without travelling back in time. It also boots from the autosave and writes back
  on every commit, debounced, so a tick, an undo and a tool call all persist by the same
  line.
- `src/layouts.ts` — everything Sous keeps in `localStorage`, which is everything it keeps
  anywhere: the autosaved session under one key, the named floor plans under another. Both
  are read defensively — the blob is editable by anyone with devtools open, so a stale or
  hand-edited value degrades to the seed scenario rather than white-screening the app, and
  `JSON.parse` runs with a reviver that drops `__proto__`, `constructor` and `prototype`.
- `vercel.json` — the security headers, and immutable caching for the content-hashed
  assets. Sous loads nothing third-party, so the CSP is a real `default-src 'self'`, with
  `'unsafe-inline'` on style-src only because React writes a few values as inline style
  attributes. Verified against the deployed origin rather than read: an injected external
  script, an inline script, an outbound `fetch` and an attempt to frame the page are all
  blocked.
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

Both are handled in the tree rather than promised. Every read that returns user-typed text
carries `untrustedContentHint` and wraps that text in `<untrusted>` spans it cannot escape,
and no user string ever reaches a tool schema — enums come from author-controlled
registries only (stations, sections, menu items), never from table or party names.
`scripts/check-tools.ts` asserts both, tool by tool.

**The pin rule is already real and already tested.** An agent may pin; only a human may
unpin, so a successful injection still cannot unprotect what a human protected. Agent-
supplied order lines are validated as untrusted input at the boundary — unknown ids, 86'd
dishes, course mismatches and unbounded quantities are all rejected by the executor rather
than left to schema validation — and every string a tool can write into state is length-
capped. `scripts/check-mutations.ts` asserts all of it, including that a refused mutation
never half-writes.

**`localStorage` is the one that gets forgotten**, and it is the app's only persistence:
the autosaved board is deserialised on every boot, and it is editable by anyone with
devtools open. Both keys are parsed inside `try/catch` with a reviver that drops
`__proto__`, `constructor` and `prototype`, then shape-checked before anything is
restored — a stale or hand-edited blob falls back to the seed scenario. Parsed values are
never spread into state.

What *is* true of this tree today: no `dangerouslySetInnerHTML` or `innerHTML` anywhere, no
user-controlled `href`/`src`/`style`, no production source maps, no secrets (there is
nowhere to put one), and a clean `npm audit` over two runtime dependencies.

`window.__sous` is a deliberate, documented exposure for testing and the Chrome evals
harness, called out here so it reads as a decision rather than an oversight. It offers
exactly two things — `listTools()` and `invoke(name, args)` — and no direct state accessor,
so anything a page script can reach through it is something a registered tool would hand an
agent anyway. `invoke` runs the same validation and the same mutation path as the tool
wrapper, stamped `agent`, so pins and the design-mode gate still refuse it. Acceptable for a
demo with no accounts, no real data and no backend.

## Licence

MIT — see [LICENSE](./LICENSE). The bundled Silkscreen and Instrument Sans fonts are SIL
Open Font License 1.1; see [NOTICE](./NOTICE).

# Sous

*Your second on the line.*

One restaurant, one screen, one dinner service. You and your agent design the room, then
run it together.

A submission for [the WebMCP Challenge](https://webmcp.devpost.com/). WebMCP lets a web
page register tools an AI agent can call directly, so the agent and the person are working
on the *same live page* rather than through an API.

**Status: in progress.** Days 1 and 2 of 6 are complete — domain model, seed scenario,
floor-plan renderer and the simulation engine. Mutations, the conflict engine, the detail
panes and the WebMCP tool surface are still to come, so **nothing below about tools
describes shipped code yet**; it describes what is being built.

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
| `npm run check` | Both check scripts: seed consistency (seat totals, integer geometry, table overlap, 915 mm aisle clearance, section coverage, menu routing) and a headless open-to-close shift |
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

- `src/types.ts` — the domain model. All geometry is in **cells** (1 cell = 0.125 m), so
  the SVG `viewBox` is itself the pixel grid. Timestamps are absolute shift-minutes;
  elapsed values are derived at render, never stored.
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
- `scripts/check-seed.ts`, `scripts/check-sim.ts` — the checks above. The simulation check
  walks a whole shift a minute at a time and asserts, every minute, that nothing finishes
  before it starts, no station exceeds its concurrency, courses land together and never run
  backwards, and one party sits per table — then that the night resolves with the room
  empty. It also asserts `tick` is pure and that the same seed replays the same evening.

### On the pixel art

The floor is deliberately pixel-art while everything around it is clean and modern: the
room reads as a board, the instruments read as a tool. It is drawn with SVG patterns and
polygons at integer cell coordinates with `shape-rendering: crispEdges`, and rendered at an
integer scale so cells land on whole device pixels. Accessibility is not traded for it.

### Accessibility

Tables are keyboard-traversable with visible focus and descriptive labels; agent activity
is announced through a live region. Aisle clearance is a real domain constraint in the
conflict engine, checked against the ADA 2010 §403.5.1 accessible-route minimum of 915 mm.

## Security

No backend, no accounts, no PII, no money — which deletes most of the classic
vulnerability list and leaves two risks that genuinely apply: **indirect prompt injection**
(anything the agent reads is a potential instruction) and the fact that **the tool surface
is effectively an unauthenticated public API**.

The tool surface does not exist yet, so these are commitments the build is being held to,
not properties you can audit in this tree today: tools returning user-typed text will carry
`untrustedContentHint`; user strings will never reach a tool schema, only author-controlled
registries will; and the pin rule will be asymmetric — an agent may pin, only a human may
unpin — so a successful injection still cannot unprotect what a human protected.

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

# Sous

*Your second on the line.*

One restaurant, one screen, one dinner service. You and your agent design the room, then
run it together.

A submission for [the WebMCP Challenge](https://webmcp.devpost.com/). WebMCP lets a web
page register tools an AI agent can call directly, so the agent and the person are working
on the *same live page* rather than through an API.

**Status: in progress.** Day 1 of 6 is complete — domain model, seed scenario and the
floor-plan renderer. The simulation engine, mutations, detail panes and the WebMCP tool
surface are still to come.

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
| `npm run check` | Seed consistency asserts — seat totals, integer geometry, table overlap, 915 mm aisle clearance, section coverage, menu routing |
| `npm run build` | Type-check and production build |
| `npm run lint` | oxlint |

`npm run check` runs on plain `node` using native TypeScript type-stripping — no test
framework and no bundler, which is why relative imports carry explicit `.ts` extensions.

To use the agent side you need WebMCP enabled: Chrome with
`chrome://flags/#enable-webmcp-testing`, or ChatGPT's in-app browser.

## How it is built

React + Vite + TypeScript. **No backend, no database, no auth** — state lives in memory
and autosaves to `localStorage`. No chart, drag or state-management libraries.

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
- `scripts/check-seed.ts` — the consistency check above.

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
is effectively an unauthenticated public API**. Tools returning user-typed text are marked
`untrustedContentHint`, user strings never reach a tool schema, and the pin rule is
asymmetric so a successful injection still cannot unprotect what a human protected.

`window.__sous` is a deliberate, documented exposure for testing and the Chrome evals
harness. It is read/write access to app state for any script on the page — acceptable for a
demo with no real data, and called out here so it reads as a decision rather than an
oversight.

## Licence

MIT — see [LICENSE](./LICENSE), which also covers the bundled Silkscreen and Instrument
Sans fonts (SIL Open Font License 1.1).

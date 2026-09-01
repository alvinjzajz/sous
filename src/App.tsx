// The shell: the three-column layout from "../Sous Restaurant Manager.html", driven by
// the live simulation and by the mutation path in store.ts.
//
// Every button here calls a plain function from mutations.ts through sous.run(). The
// day-5 WebMCP tools call the same functions the same way, which is why a pin refusal
// reads identically whether a person or an agent asked (CLAUDE.md #5).
//
// CLICK ROUTING (§1, "one canvas, six panes"): selection stays a single id and the pane
// is resolved by membership, not by a parallel "kind" field. That is the shape day 5's
// set_view({ focus }) needs — moving the viewport becomes one setState.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import FloorPlan, { HOST_ID } from './FloorPlan.tsx';
import {
  BookingRows, FloorPane, HostPane, SectionPane, StationPane, TablePane, TicketPane,
  WaitRows,
} from './Panes.tsx';
import { updateTable } from './mutations.ts';
import type { Result } from './mutations.ts';
import { floorPlan, menu } from './seed.ts';
import { openBookings, serviceOver, stationLoad } from './sim.ts';
import { useSous } from './store.ts';
import { makeImpls, toolDefs } from './tools.ts';
import { useWebMCP } from './webmcp.ts';
import { CELL_M, fmtClock } from './types.ts';
import type { SousState } from './types.ts';

const MODES = [
  { id: 'design', name: 'Design', blurb: 'Build the room' },
  { id: 'service', name: 'Service', blurb: 'Run the night' },
] as const;

/** Real seconds per shift-minute is 1 at 1x, so 60x runs the whole night in five minutes. */
const SPEEDS = [1, 8, 60] as const;
/** 7:15 PM — the room the demo opens on (§9, 1:15). */
const PEAK = 135;

/**
 * Built once at module scope, not per render, because useWebMCP registers on the identity
 * of this array and re-registering 30 tools on every tick would be the one mistake §3
 * warns about. Safe to freeze: menu ids and section ids are seeded registries that no
 * mutation renames, which is exactly why they are the only things allowed to be enums.
 */
const TOOL_DEFS = toolDefs(menu, floorPlan.sections.map((s) => s.id));

export default function App() {
  const sous = useSous();
  const { state, conflicts } = sous;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const { plan, shift, waitlist } = state;
  const mode = shift.mode;
  /** Tonight's book, minus what has been seated or written off (see openBookings). */
  const book = openBookings(state);

  /** The mutation path. Everything a person clicks goes through here. */
  const act = (fn: (draft: SousState) => Result<unknown>) => {
    sous.run(fn);
  };

  const over = serviceOver(state);
  const seats = plan.tables.reduce((n, t) => n + t.seats, 0);
  // Departed parties stay in state so the night has a history; they are not in the room.
  const live = state.parties.filter((p) => p.course !== 'departed');
  const seated = live.reduce((n, p) => n + p.size, 0);
  const roomM = (n: number) => +(n * CELL_M).toFixed(1);

  // One id in, one pane out. Nothing here couples to how ids are spelled.
  const table = plan.tables.find((t) => t.id === selectedId) ?? null;
  const station = plan.stations.find((s) => s.id === selectedId) ?? null;
  const section = plan.sections.find((s) => s.id === selectedId) ?? null;
  const atHost = selectedId === HOST_ID;
  const paneName = table
    ? `TABLE ${table.name}`
    : station
      ? station.type === 'pass' ? 'THE PASS' : station.name.toUpperCase()
      : section
        ? `${section.name.toUpperCase()} SECTION`
        : atHost ? 'HOST STAND' : 'FLOOR';

  const errors = conflicts.filter((c) => c.severity === 'error');
  const warnings = conflicts.filter((c) => c.severity === 'warn');
  const focusOn = (targetId: string) =>
    setSelectedId(plan.tables.some((t) => t.id === targetId) ? targetId : null);

  const paneProps = { sous, act, select: setSelectedId };

  // The agent's half. Rebuilt every render and read through a ref inside the hook, so
  // the closures never go stale and the effect still runs exactly once (§3).
  const mcp = useWebMCP(TOOL_DEFS, makeImpls(sous, { focus: setSelectedId }));

  return (
    <div className="app">
      {leftOpen ? (
        <aside className="rail rail--left">
          <div className="brand">
            <div>
              <h1 className="wordmark">SOUS</h1>
              <small>Bistro Verdant · Rue Sud</small>
            </div>
            <button className="chevron chevron--sm" onClick={() => setLeftOpen(false)} title="Collapse">
              ‹
            </button>
          </div>

          {/* Judges opening this in a browser without WebMCP still need to see that the
              surface exists — SHOWCASE_TEARDOWN.md's checklist, and WanderNote's phrasing. */}
          <p className={`mcp mcp--${mcp.supported ? 'live' : 'fallback'}`}>
            <b>{mcp.supported ? 'Native browser WebMCP connected' : 'Browser bridge ready'}</b>
            <span>
              {mcp.supported
                ? `${mcp.registered.length} of ${TOOL_DEFS.length} tools registered`
                : `native WebMCP unavailable · ${TOOL_DEFS.length} tools ready on window.__sous`}
            </span>
            {mcp.errors.length > 0 && <em>{mcp.errors.length} failed to register</em>}
          </p>

          <div className="modes">
            <span className="eyebrow">MODE</span>
            {MODES.map((m) => (
              <button
                key={m.id}
                className="mode"
                aria-pressed={mode === m.id}
                // THE CLOCK ONLY RUNS IN SERVICE MODE (§8). Run and "→ 7:15" already
                // force service; this is the other half. Pausing, never resetting —
                // every timestamp is absolute, so it resumes with nothing stale.
                onClick={() =>
                  sous.setShift(m.id === 'design' ? { mode: 'design', running: false } : { mode: 'service' })
                }
              >
                <strong>{m.name}</strong>
                <span>{m.blurb}</span>
              </button>
            ))}
          </div>

          {/* The two queues, and nothing else. Tables, service notes and the menu all
              live in the right column already; repeating their counts here was chrome. */}
          <ul className="nav">
            <li className="navOpen">
              <details>
                <summary>
                  <span>Reservations</span>
                  <b>{book.length}</b>
                </summary>
                <BookingRows entries={book} clock={shift.clock} brief />
              </details>
            </li>
            {/* The door, on the manager's side of the screen. This is what replaced the
                `quote-blown` conflict: the wait against the quote sits on the party it
                describes rather than shouting from the conflicts strip. */}
            <li className="navOpen">
              <details>
                <summary>
                  <span>Waitlist</span>
                  <b>{waitlist.length}</b>
                </summary>
                <WaitRows entries={waitlist} clock={shift.clock} brief />
              </details>
            </li>
          </ul>

          <div className="tonight">
            <span className="eyebrow">TONIGHT</span>
            <p>
              Saturday · Dinner
              <br />
              <span>Doors 5:00 · Last seat 9:45</span>
            </p>
            <div className="covers">
              <b>{seated}</b>
              <span>of {seats} covers</span>
            </div>
            <div className="meter">
              <div style={{ width: `${(seated / seats) * 100}%` }} />
            </div>
          </div>
        </aside>
      ) : (
        <aside className="rail rail--left rail--collapsed">
          <button className="chevron" onClick={() => setLeftOpen(true)} title="Expand">
            ›
          </button>
          <span className="railSpine">SOUS</span>
        </aside>
      )}

      <main className="main">
        <header className="topbar">
          <div>
            <h1>Main Dining Room</h1>
            <p>
              {roomM(plan.bounds.w)} × {roomM(plan.bounds.h)} m · {plan.tables.length} tables ·{' '}
              {seats} seats · {plan.sections.length} sections
            </p>
          </div>
          <div className="transport">
            <div className={mode === 'service' ? 'pill pill--service' : 'pill'}>
              <i />
              {over ? 'CLOSED' : mode === 'design' ? 'DESIGN' : 'SERVICE'} · {fmtClock(shift.clock)}
            </div>
            {/* The transport belongs to SERVICE. Design mode pauses the shift by
                definition, so a Run button there is a door back into a state the mode
                forbids — switch to Service and the whole transport comes back. */}
            {mode === 'service' && (
              <>
                <button
                  className="tbtn"
                  aria-pressed={shift.running}
                  disabled={over}
                  onClick={() => sous.setShift({ running: !shift.running, mode: 'service' })}
                >
                  {shift.running ? '❚❚ Pause' : '▶ Run'}
                </button>
                {SPEEDS.map((x) => (
                  <button
                    key={x}
                    className="tbtn tbtn--sm"
                    aria-pressed={shift.speed === x}
                    onClick={() => sous.setShift({ speed: x })}
                  >
                    {x}×
                  </button>
                ))}
                <button className="tbtn" onClick={() => sous.jumpTo(PEAK)} disabled={shift.clock >= PEAK}>
                  → 7:15
                </button>
              </>
            )}
            {/* Undo is a mutation-path control, not a transport one: it rewinds the
                board and leaves the clock running (§2, rule 2). Run at 60x and watch
                these stay greyed out — ticks never push a snapshot. */}
            <button className="tbtn tbtn--sm" onClick={sous.undo} disabled={!sous.canUndo} title="Undo the last edit">
              ↶ Undo
            </button>
            <button className="tbtn tbtn--sm" onClick={sous.redo} disabled={!sous.canRedo} title="Redo">
              ↷
            </button>
            <button className="tbtn" onClick={sous.reset}>
              Reset
            </button>
          </div>
        </header>

        <div
          className="stage"
          style={{ '--room': String(plan.bounds.w / plan.bounds.h) } as CSSProperties}
        >
          <FloorPlan
            plan={plan}
            parties={state.parties}
            cooking={stationLoad(state)}
            queued={stationLoad(state, 'queued')}
            conflicts={conflicts}
            selectedId={selectedId}
            onSelect={setSelectedId}
            canDrag={mode === 'design'}
            onMove={(tableId, x, y) => act((d) => updateTable(d, { tableId, x, y }, 'human'))}
          />
        </div>

        <footer className="footbar">
          <ul>
            {plan.sections.map((s) => (
              <li key={s.id}>
                <span className="swatch" style={{ background: `var(${s.color})` }} />
                <button className="linkish" onClick={() => setSelectedId(s.id)}>
                  {s.name} · {s.serverName}
                </button>
              </li>
            ))}
          </ul>
          <div className="alarms">
            {conflicts.length === 0 ? (
              <span className="hint">No conflicts</span>
            ) : (
              <>
                {errors.length > 0 && (
                  <button className="chip chip--error" onClick={() => focusOn(errors[0].targetId)}>
                    {errors.length} error{errors.length > 1 ? 's' : ''}
                  </button>
                )}
                {warnings.length > 0 && (
                  <button className="chip chip--warn" onClick={() => focusOn(warnings[0].targetId)}>
                    {warnings.length} warning{warnings.length > 1 ? 's' : ''}
                  </button>
                )}
                <span className="hint">{(errors[0] ?? warnings[0]).message}</span>
              </>
            )}
          </div>
        </footer>
      </main>

      {rightOpen ? (
        <aside className="rail rail--right">
          <div className="paneHead">
            <span>{paneName}</span>
            <button className="chevron chevron--sm" onClick={() => setRightOpen(false)} title="Collapse">
              ›
            </button>
          </div>

          <div className="paneBody">
            {table ? (
              <TablePane {...paneProps} table={table} />
            ) : station ? (
              station.type === 'pass'
                ? <TicketPane {...paneProps} />
                : <StationPane {...paneProps} station={station} />
            ) : section ? (
              <SectionPane {...paneProps} section={section} />
            ) : atHost ? (
              <HostPane {...paneProps} />
            ) : (
              <FloorPane {...paneProps} />
            )}
          </div>

          {/* The agent activity rail (§5). One line per mutation, whoever asked, and the
              refusals are the point — "Refused: T12 pinned" is the 2:40 beat. Pinned
              below the pane so it stays on screen whichever pane is open. */}
          {/* <details> rather than a useState toggle: the open/closed state, the
              keyboard handling and the disclosure semantics are the platform's. */}
          {/* The whole tool surface, on screen. This is the cheapest possible proof of
              WebMCP leverage in a three-minute video: 30 named tools a judge can read. */}
          <details className="log log--tools">
            <summary>
              <span className="eyebrow">AGENT TOOLS</span>
              <b>{TOOL_DEFS.length}</b>
            </summary>
            <div className="logBody">
              <ul className="toolList">
                {TOOL_DEFS.map((t) => {
                  const on = mcp.registered.includes(t.name);
                  const read = t.annotations?.readOnlyHint === true;
                  return (
                    <li key={t.name}>
                      <code>{t.name}</code>
                      <i className={`by by--${read ? 'human' : 'agent'}`}>
                        {t.annotations?.destructiveHint ? 'destructive' : read ? 'read' : 'writes'}
                      </i>
                      {mcp.supported && <span className={on ? 'ok' : 'hint'}>{on ? '✓' : '…'}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          </details>

          <details className="log" open>
            <summary>
              <span className="eyebrow">ACTIVITY</span>
              {sous.log.length > 0 && <b>{sous.log.length}</b>}
            </summary>
            <div className="logBody" role="log" aria-live="polite" aria-label="Activity">
              {sous.log.length === 0 ? (
                <p className="hint">Nothing yet. Every edit, yours or the agent's, lands here.</p>
              ) : (
                <ul>
                  {sous.log.map((l) => (
                    <li key={l.n} className={l.ok ? undefined : 'refused'}>
                      <b>{fmtClock(l.at)}</b>
                      <i className={`by by--${l.by}`}>{l.by}</i>
                      <span>{l.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </aside>
      ) : (
        <aside className="rail rail--right rail--collapsed">
          <button className="chevron" onClick={() => setRightOpen(true)} title="Expand">
            ‹
          </button>
          <span className="railSpine">{paneName}</span>
        </aside>
      )}
    </div>
  );
}

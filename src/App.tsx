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
import { FloorPane, HostPane, SectionPane, StationPane, TablePane, TicketPane } from './Panes.tsx';
import type { Result } from './mutations.ts';
import { serviceOver, stationLoad } from './sim.ts';
import { useSous } from './store.ts';
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

export default function App() {
  const sous = useSous();
  const { state, conflicts } = sous;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const { plan, shift, reservations, waitlist, menu } = state;
  const mode = shift.mode;
  // Notes are written during service and surface when their minute comes round (§7).
  const notes = state.notes.filter((n) => n.createdAt <= shift.clock && n.status === 'open');

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

          <ul className="nav">
            {[
              ['Tables', plan.tables.length],
              ['Reservations', reservations.length],
              ['Waitlist', waitlist.length],
              ['Service notes', notes.length],
              ['Menu', menu.length],
            ].map(([name, count]) => (
              <li key={name}>
                <span>{name}</span>
                <b>{count}</b>
              </li>
            ))}
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
          <div className="log" role="log" aria-live="polite" aria-label="Activity">
            <span className="eyebrow">ACTIVITY</span>
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

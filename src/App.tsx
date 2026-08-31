// The shell: the three-column layout from "../Sous Restaurant Manager.html", driven by
// the live simulation and, from day 3, by the mutation path in store.ts.
//
// Every button here calls a plain function from mutations.ts through sous.run(). The
// day-5 WebMCP tools call the same functions the same way, which is why a pin refusal
// reads identically whether a person or an agent asked (CLAUDE.md #5).
//
// Five of the six detail panes and the agent activity rail are day 4.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import FloorPlan from './FloorPlan.tsx';
import { clearTable, fireCourse, seatParty, setPin } from './mutations.ts';
import type { Result } from './mutations.ts';
import { serviceOver, stationLoad } from './sim.ts';
import { useSous } from './store.ts';
import { CELL_M, fmtClock } from './types.ts';
import type { MenuCourse, SousState } from './types.ts';

const MODES = [
  { id: 'design', name: 'Design', blurb: 'Build the room' },
  { id: 'service', name: 'Service', blurb: 'Run the night' },
] as const;

/** Real seconds per shift-minute is 1 at 1x, so 60x runs the whole night in five minutes. */
const SPEEDS = [1, 8, 60] as const;
/** 7:15 PM — the room the demo opens on (§9, 1:15). */
const PEAK = 135;
const COURSES: MenuCourse[] = ['drinks', 'apps', 'mains', 'dessert'];

/** Whoever the host stand would seat next: the earliest booking, then the door. */
function nextWaiting(s: SousState) {
  const r = s.reservations.filter((x) => x.status === 'arrived').sort((a, b) => a.time - b.time)[0];
  if (r) return { ref: { reservationId: r.id }, label: `${r.name} (${r.size})` };
  const w = s.waitlist[0];
  return w ? { ref: { waitId: w.id }, label: `${w.name} (${w.size})` } : null;
}

export default function App() {
  const sous = useSous();
  const { state, conflicts } = sous;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  /** ponytail: one line instead of the agent activity rail, which is day 4 (§5). */
  const [last, setLast] = useState<Result<unknown> | null>(null);

  const { plan, shift, reservations, waitlist, parties, menu } = state;
  const mode = shift.mode;
  // Notes are written during service and surface when their minute comes round (§7).
  const notes = state.notes.filter((n) => n.createdAt <= shift.clock && n.status === 'open');

  /** The mutation path. Everything a person clicks goes through here. */
  const act = (fn: (draft: SousState) => Result<unknown>) => setLast(sous.run(fn));

  const over = serviceOver(state);
  const seats = plan.tables.reduce((n, t) => n + t.seats, 0);
  // Departed parties stay in state so the night has a history; they are not in the room.
  const live = parties.filter((p) => p.course !== 'departed');
  const seated = live.reduce((n, p) => n + p.size, 0);
  const booked = reservations.reduce((n, r) => n + r.size, 0);
  const roomM = (n: number) => +(n * CELL_M).toFixed(1);
  const sentence = (v: string) => v[0].toUpperCase() + v.slice(1);

  const selected = plan.tables.find((t) => t.id === selectedId);
  const sectionOf = (id: string) => plan.sections.find((s) => s.tableIds.includes(id));
  const coversOf = (tableIds: string[]) =>
    tableIds.reduce((n, id) => n + (plan.tables.find((t) => t.id === id)?.seats ?? 0), 0);
  const partyAt = (tableId: string) =>
    live.find((p) => p.tableId === tableId || p.joinedIds.includes(tableId)) ?? null;

  const errors = conflicts.filter((c) => c.severity === 'error');
  const warnings = conflicts.filter((c) => c.severity === 'warn');
  const focusOn = (targetId: string) =>
    setSelectedId(plan.tables.some((t) => t.id === targetId) ? targetId : null);

  const party = selected ? partyAt(selected.id) : null;
  const waiting = nextWaiting(state);
  const nextCourse = party ? COURSES.find((c) => !state.tickets.some((t) => t.partyId === party.id && t.course === c)) : undefined;
  const paneName = selected ? `TABLE ${selected.name}` : 'FLOOR';

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
                onClick={() => sous.setShift({ mode: m.id })}
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
            <button className="tbtn" onClick={() => { sous.reset(); setLast(null); }}>
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
            parties={parties}
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
                {s.name} · {s.serverName}
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

          {selected ? (
            <>
              <div className="block">
                <button className="back" onClick={() => setSelectedId(null)}>
                  ← All tables
                </button>
                <div className="detailHead">
                  <div>
                    <h2>{selected.name}</h2>
                    <p>
                      {sectionOf(selected.id)?.name} section · {sectionOf(selected.id)?.serverName}
                    </p>
                  </div>
                  <span className="tag">{party ? sentence(party.course) : 'Open'}</span>
                </div>
              </div>

              <div className="block">
                <div className="stats">
                  {[
                    ['SEATS', String(selected.seats)],
                    ['SHAPE', sentence(selected.shape)],
                    ['SIZE', `${roomM(selected.w)} × ${roomM(selected.h)} m`],
                    ['PLACED BY', sentence(selected.provenance)],
                    ['PINNED', selected.pinned || party?.pinned ? 'Yes' : 'No'],
                    ['PARTY', party ? `${party.name} · ${party.size}` : 'None'],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <span className="eyebrow">{k}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
              </div>

              {/* ponytail: four buttons standing in for the six detail panes, which are
                  day 4. Ceiling — no menu picker, no ticket rail, no reservation list;
                  these exist to drive every mutation through the same path the tools
                  will use, and day 4 replaces the whole block. */}
              <div className="block">
                <span className="eyebrow">ACTIONS</span>
                <div className="actions">
                  <button
                    className="tbtn"
                    disabled={!waiting || !!party}
                    title={waiting ? `Seat ${waiting.label}` : 'Nobody is waiting'}
                    onClick={() => waiting && act((d) => seatParty(d, { ...waiting.ref, tableIds: [selected.id] }, 'human'))}
                  >
                    Seat {waiting ? waiting.label : 'next'}
                  </button>
                  <button
                    className="tbtn"
                    disabled={!party || !nextCourse}
                    onClick={() => party && nextCourse && act((d) => fireCourse(d, { partyId: party.id, course: nextCourse }, 'human'))}
                  >
                    Fire {nextCourse ?? 'course'}
                  </button>
                  <button
                    className="tbtn"
                    aria-pressed={selected.pinned || party?.pinned}
                    onClick={() => act((d) => setPin(d, { targetId: selected.id, pinned: !(selected.pinned || party?.pinned) }, 'human'))}
                  >
                    {selected.pinned || party?.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    className="tbtn"
                    disabled={!party}
                    onClick={() => act((d) => clearTable(d, { tableId: selected.id }, 'human'))}
                  >
                    Clear
                  </button>
                </div>
                {last && (
                  <p className={last.ok ? 'said' : 'said said--no'} role="status">
                    {last.message}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="block">
                <span className="eyebrow">ROOM</span>
                <div className="stats">
                  {[
                    ['TABLES', String(plan.tables.length)],
                    ['SEATS', String(seats)],
                    ['BOOKED', `${booked} covers`],
                    ['RESERVATIONS', String(reservations.length)],
                    ['MENU', `${menu.length} items`],
                    ['STATIONS', String(plan.stations.length)],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <span className="eyebrow">{k}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="block">
                <span className="eyebrow">CONFLICTS</span>
                {conflicts.length === 0 ? (
                  <p className="said">
                    Nothing to fix. The same engine checks the layout and the service board.
                  </p>
                ) : (
                  <ul className="issues">
                    {conflicts.map((c, i) => (
                      <li key={`${c.type}-${c.targetId}-${i}`}>
                        <button className={`chip chip--${c.severity}`} onClick={() => focusOn(c.targetId)}>
                          {c.type}
                        </button>
                        <span>
                          {c.message}
                          {c.suggestion ? <em> {c.suggestion}</em> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="block">
                <span className="eyebrow">SECTIONS</span>
                <ul className="sections">
                  {plan.sections.map((s) => (
                    <li key={s.id}>
                      <span className="swatch" style={{ background: `var(${s.color})` }} />
                      <span>
                        {s.name} · {s.serverName}
                      </span>
                      <span>
                        {s.tableIds.length} tables · {coversOf(s.tableIds)} covers
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="block">
                <span className="eyebrow">SERVICE NOTES</span>
                <ul className="sections">
                  {notes.map((n) => (
                    <li key={n.id}>
                      <span>
                        {n.tableId} · from the {n.from}
                      </span>
                      <span>{fmtClock(n.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
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

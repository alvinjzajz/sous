// The shell: the three-column layout from "../Sous Restaurant Manager.html", now driven
// by the live simulation. Mutations, the conflict engine and the tools are days 3 and 5
// (SOUS_PLAN.md §8); five of the six detail panes are day 4.
import { useEffect, useState } from 'react';
import FloorPlan from './FloorPlan.tsx';
import { seedState } from './seed.ts';
import { advanceTo, serviceOver, stationLoad, tick } from './sim.ts';
import { CELL_M, fmtClock } from './types.ts';
import type { Shift, SousState } from './types.ts';

const MODES = [
  { id: 'design', name: 'Design', blurb: 'Build the room' },
  { id: 'service', name: 'Service', blurb: 'Run the night' },
] as const;

/** Real seconds per shift-minute is 1 at 1x, so 60x runs the whole night in five minutes. */
const SPEEDS = [1, 8, 60] as const;
/** 7:15 PM — the room the demo opens on (§9, 1:15). */
const PEAK = 135;

export default function App() {
  const [state, setState] = useState<SousState>(seedState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const { plan, shift, reservations, waitlist, parties, menu } = state;
  const mode = shift.mode;
  // Notes are written during service and surface when their minute comes round (§7).
  const notes = state.notes.filter((n) => n.createdAt <= shift.clock);

  // THE TICK PATH. Separate from the mutation path, and it never pushes an undo
  // snapshot (§2, rule 1). `tick` is pure, so React 19's double-invoked updater in
  // StrictMode produces the same minute twice rather than advancing two.
  useEffect(() => {
    if (!shift.running) return;
    const id = setInterval(() => setState(tick), Math.max(16, 1000 / shift.speed));
    return () => clearInterval(id);
  }, [shift.running, shift.speed]);

  const over = serviceOver(state);
  const setShift = (patch: Partial<Shift>) =>
    setState((s) => ({ ...s, shift: { ...s.shift, ...patch } }));
  /** Fast-forward through the book. Same seed, same room, every run (§7). */
  const jumpTo = (minute: number) =>
    setState((s) =>
      advanceTo({ ...s, shift: { ...s.shift, mode: 'service', running: false } }, minute),
    );
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
                onClick={() => setShift({ mode: m.id })}
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
              onClick={() => setShift({ running: !shift.running, mode: 'service' })}
            >
              {shift.running ? '❚❚ Pause' : '▶ Run'}
            </button>
            {SPEEDS.map((x) => (
              <button
                key={x}
                className="tbtn tbtn--sm"
                aria-pressed={shift.speed === x}
                onClick={() => setShift({ speed: x })}
              >
                {x}×
              </button>
            ))}
            <button className="tbtn" onClick={() => jumpTo(PEAK)} disabled={shift.clock >= PEAK}>
              → 7:15
            </button>
            <button className="tbtn" onClick={() => setState(seedState())}>
              Reset
            </button>
          </div>
        </header>

        <div className="stage">
          <div className="floorFrame">
            <FloorPlan
              plan={plan}
              parties={parties}
              cooking={stationLoad(state)}
              queued={stationLoad(state, 'queued')}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
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
          <span className="hint">
            {booked} covers booked across {reservations.length} reservations
          </span>
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
                  <span className="tag">Open</span>
                </div>
              </div>

              <div className="block">
                <div className="stats">
                  {[
                    ['SEATS', String(selected.seats)],
                    ['SHAPE', sentence(selected.shape)],
                    ['SIZE', `${roomM(selected.w)} × ${roomM(selected.h)} m`],
                    ['PLACED BY', sentence(selected.provenance)],
                    ['PINNED', selected.pinned ? 'Yes' : 'No'],
                    ['PARTY', 'None'],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <span className="eyebrow">{k}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="block">
                <span className="eyebrow">NEXT ON THIS TABLE</span>
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-mute)', lineHeight: 1.6 }}>
                  The shift has not started. Reservations begin seating at 6:00 PM.
                </p>
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

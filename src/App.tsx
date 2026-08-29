// Day 1 shell: the seed scenario rendered read-only. No mutations, no clock, no
// tools yet — those are days 2, 3 and 5 (MISE_PLAN.md §8).
import { useMemo, useState } from 'react';
import FloorPlan from './FloorPlan.tsx';
import { seedState } from './seed.ts';
import { fmtClock } from './types.ts';

export default function App() {
  const state = useMemo(() => seedState(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { plan, shift, reservations } = state;
  const seats = plan.tables.reduce((n, t) => n + t.seats, 0);
  const selected = plan.tables.find((t) => t.id === selectedId);
  const section = selected
    ? plan.sections.find((s) => s.tableIds.includes(selected.id))
    : undefined;
  const covers = reservations.reduce((n, r) => n + r.size, 0);

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">MISE</h1>
        <span className="tagline">Everything in its place</span>
        <span className="spacer" />
        <span className="clock">{fmtClock(shift.clock)}</span>
      </header>

      <main className="stage">
        <FloorPlan
          plan={plan}
          parties={state.parties}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        <aside className="rail">
          {selected ? (
            <>
              <h2>Table {selected.name}</h2>
              <dl>
                <dt>Seats</dt>
                <dd>{selected.seats}</dd>
                <dt>Shape</dt>
                <dd>{selected.shape}</dd>
                <dt>Section</dt>
                <dd>{section ? `${section.name} · ${section.serverName}` : '—'}</dd>
                <dt>Party</dt>
                <dd>Empty</dd>
                <dt>Placed by</dt>
                <dd>{selected.provenance}</dd>
                <dt>Pinned</dt>
                <dd>{selected.pinned ? 'Yes' : 'No'}</dd>
              </dl>
            </>
          ) : (
            <>
              <h2>Floor</h2>
              <dl>
                <dt>Tables</dt>
                <dd>{plan.tables.length}</dd>
                <dt>Seats</dt>
                <dd>{seats}</dd>
                <dt>Room</dt>
                <dd>
                  {plan.bounds.w / 8} × {plan.bounds.h / 8} m
                </dd>
                <dt>Booked</dt>
                <dd>
                  {reservations.length} res · {covers} covers
                </dd>
                <dt>Menu</dt>
                <dd>{state.menu.length} items</dd>
              </dl>
              <ul className="legend">
                {plan.sections.map((s) => (
                  <li key={s.id}>
                    <span className="swatch" style={{ background: `var(${s.color})` }} />
                    {s.name} · {s.serverName} ·{' '}
                    {s.tableIds.reduce(
                      (n, id) => n + (plan.tables.find((t) => t.id === id)?.seats ?? 0),
                      0,
                    )}{' '}
                    covers
                  </li>
                ))}
                <li>
                  <span className="swatch" style={{ background: 'var(--sage)' }} /> Window
                </li>
                <li>
                  <span className="swatch" style={{ background: 'var(--amber)' }} /> Door
                </li>
              </ul>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

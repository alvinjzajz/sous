// The six detail panes (SOUS_PLAN.md §1). The canvas is the hub, these are the spokes,
// and each one maps onto a tool group — so day 5's tools read the state a pane already
// reads and call the mutation a button already calls (CLAUDE.md #5).
//
// EVERY elapsed number here is derived against shift.clock and never stored (CLAUDE.md
// #2). "23 min on table" recomputes every frame, which is what stops undo resurrecting
// a stale countdown.
//
// No local state anywhere in this file: the three forms are plain <form> + FormData,
// which is the platform doing the work a useState triple would have done.
import type { FormEvent } from 'react';
import {
  ANCHORS, addTable, addToWaitlist, applyLayoutTemplate, assignSection, clearTable,
  fireCourse, removeTable, reshape, resolveNote, retimeTicket, seatParty, setPin,
  swapTicketItem, updateTable,
} from './mutations.ts';
import type { Reshape, Result } from './mutations.ts';
import { pickTable } from './sim.ts';
import type { Sous } from './store.ts';
import { CELL_M, fmtClock } from './types.ts';
import type { MenuCourse, Section, SousState, Station, Table } from './types.ts';

export interface PaneProps {
  sous: Sous;
  /** The mutation path. Everything a person clicks goes through here. */
  act: (fn: (draft: SousState) => Result<unknown>) => void;
  select: (id: string | null) => void;
}

const COURSES: MenuCourse[] = ['drinks', 'apps', 'mains', 'dessert'];
const RESHAPES: { kind: Reshape; label: string }[] = [
  { kind: 'rotate', label: 'Rotate 90°' },
  { kind: 'grow', label: 'Grow' },
  { kind: 'shrink', label: 'Shrink' },
  { kind: 'widen', label: 'Widen' },
];

const sentence = (v: string) => v[0].toUpperCase() + v.slice(1);
const roomM = (n: number) => +(n * CELL_M).toFixed(1);
const refuse = (message: string): Result<never> => ({ ok: false, message });

function Stats({ rows }: { rows: [string, string][] }) {
  return (
    <div className="stats">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="eyebrow">{k}</span>
          <strong>{v}</strong>
        </div>
      ))}
    </div>
  );
}

/** Read a form, then clear it. Captured before the handler runs anything async-looking. */
function fields(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const form = e.currentTarget;
  const data = new FormData(form);
  form.reset();
  return (name: string) => String(data.get(name) ?? '');
}

const liveParties = (s: SousState) => s.parties.filter((p) => p.course !== 'departed');

/** Whoever the host stand would seat next: the earliest booking, then the door. */
function nextWaiting(s: SousState) {
  const r = s.reservations.filter((x) => x.status !== 'seated' && x.status !== 'no-show')
    .sort((a, b) => a.time - b.time)[0];
  if (r) return { ref: { reservationId: r.id }, label: `${r.name} (${r.size})` };
  const w = s.waitlist[0];
  return w ? { ref: { waitId: w.id }, label: `${w.name} (${w.size})` } : null;
}

// --- 1. A table --------------------------------------------------------------

export function TablePane({ sous, act, select, table }: PaneProps & { table: Table }) {
  const { plan, shift, tickets, menu } = sous.state;
  const party = liveParties(sous.state)
    .find((p) => p.tableId === table.id || p.joinedIds.includes(table.id)) ?? null;
  const section = plan.sections.find((s) => s.tableIds.includes(table.id));
  const design = shift.mode === 'design';
  const pinned = table.pinned || !!party?.pinned;
  const waiting = nextWaiting(sous.state);
  const mine = party ? tickets.filter((t) => t.partyId === party.id) : [];
  const nextCourse = party ? COURSES.find((c) => !mine.some((t) => t.course === c)) : undefined;
  const named = (id: string) => plan.tables.find((t) => t.id === id)?.name ?? id;

  return (
    <>
      <div className="block">
        <button className="back" onClick={() => select(null)}>← All tables</button>
        <div className="detailHead">
          <div>
            <h2>{table.name}</h2>
            <p>{section ? `${section.name} section · ${section.serverName}` : 'No section'}</p>
          </div>
          <span className="tag">{party ? sentence(party.course) : 'Open'}</span>
        </div>
      </div>

      <div className="block">
        <Stats
          rows={[
            ['SEATS', String(table.seats)],
            ['SHAPE', sentence(table.shape)],
            ['SIZE', `${roomM(table.w)} × ${roomM(table.h)} m`],
            ['PLACED BY', sentence(table.provenance)],
            ['PINNED', pinned ? 'Yes' : 'No'],
            ['PARTY', party ? `${party.name} · ${party.size}` : 'None'],
          ]}
        />
      </div>

      {design ? (
        <div className="block">
          <span className="eyebrow">SHAPE</span>
          <div className="actions">
            {RESHAPES.map(({ kind, label }) => {
              // null means the button is genuinely inapplicable — rotate on a round
              // table, or a seat count off the end. Disable rather than ship it dead (§4).
              const args = reshape(table, kind, plan.gridSize);
              return (
                <button
                  key={kind}
                  className="tbtn"
                  disabled={!args}
                  title={args ? label : `${label} does not apply to ${table.name}`}
                  onClick={() => args && act((d) => updateTable(d, args, 'human'))}
                >
                  {label}
                </button>
              );
            })}
            <button
              className="tbtn"
              title="Place a copy at the nearest spot that clears the aisles"
              onClick={() =>
                act((d) =>
                  addTable(d, {
                    seats: table.seats,
                    shape: table.shape,
                    near: { x: table.x, y: table.y },
                  }, 'human'))
              }
            >
              Duplicate
            </button>
            <button
              className="tbtn tbtn--no"
              onClick={() => act((d) => removeTable(d, { tableId: table.id }, 'human'))}
            >
              Delete
            </button>
          </div>

          <form
            className="field"
            onSubmit={(e) => {
              const f = fields(e);
              const name = f('name');
              if (name && name !== table.name) {
                act((d) => updateTable(d, { tableId: table.id, name }, 'human'));
              }
            }}
          >
            <span className="eyebrow">NAME</span>
            <input name="name" defaultValue={table.name} maxLength={24} key={table.name} />
            <button className="tbtn tbtn--sm" type="submit">Rename</button>
          </form>

          <label className="field">
            <span className="eyebrow">SECTION</span>
            <select
              value={section?.id ?? ''}
              onChange={(e) => {
                const sectionId = e.target.value;
                act((d) => assignSection(d, { tableIds: [table.id], sectionId }, 'human'));
              }}
            >
              {plan.sections.map((s) => (
                <option key={s.id} value={s.id}>{s.name} · {s.serverName}</option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div className="block">
          <span className="eyebrow">PARTY</span>
          {party ? (
            <>
              <Stats
                rows={[
                  ['SEATED', fmtClock(party.seatedAt)],
                  ['ON TABLE', `${shift.clock - party.seatedAt} min`],
                  ['COURSE', sentence(party.course)],
                  ['IN COURSE', `${shift.clock - party.courseAt} min`],
                ]}
              />
              {party.allergies.length > 0 && (
                <p className="said said--no">Allergies: {party.allergies.join(', ')}</p>
              )}
              {party.vip && <p className="said">VIP.</p>}
              {party.notes && <p className="said">{party.notes}</p>}
              {party.joinedIds.length > 0 && (
                <p className="said">Pushed together with {party.joinedIds.map(named).join(', ')}.</p>
              )}
            </>
          ) : (
            <p className="said">
              Open.{' '}
              {waiting ? `${waiting.label} is next at the door.` : 'Nobody is waiting.'}
            </p>
          )}
        </div>
      )}

      {!design && party && (
        <div className="block">
          <span className="eyebrow">TICKETS</span>
          {mine.length === 0 ? (
            <p className="said">Nothing fired yet.</p>
          ) : (
            <ul className="issues">
              {mine.map((t) => {
                const late = shift.clock - t.dueAt;
                const served = t.items.every((i) => i.status === 'served');
                return (
                  <li key={t.id}>
                    <span className={`chip${!served && late > 0 ? ' chip--warn' : ''}`}>{t.course}</span>
                    <span>
                      {t.items.map((i) => `${i.qty}× ${menu.find((m) => m.id === i.menuItemId)?.name}`).join(', ')}
                      <em>
                        {' '}
                        Due {fmtClock(t.dueAt)}
                        {served ? ' · on the table' : late > 0 ? ` · ${late} min late` : ''}
                      </em>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="block">
        <span className="eyebrow">ACTIONS</span>
        <div className="actions">
          <button
            className="tbtn"
            aria-pressed={pinned}
            title={pinned ? 'Only a human may unpin' : 'Tools will refuse to touch it'}
            onClick={() => act((d) => setPin(d, { targetId: table.id, pinned: !pinned }, 'human'))}
          >
            {pinned ? 'Unpin' : 'Pin'}
          </button>
          {!design && (
            <>
              <button
                className="tbtn"
                disabled={!waiting || !!party}
                title={waiting ? `Seat ${waiting.label}` : 'Nobody is waiting'}
                onClick={() =>
                  waiting && act((d) => seatParty(d, { ...waiting.ref, tableIds: [table.id] }, 'human'))
                }
              >
                Seat {waiting ? waiting.label : 'next'}
              </button>
              <button
                className="tbtn"
                disabled={!party || !nextCourse}
                onClick={() =>
                  party && nextCourse &&
                  act((d) => fireCourse(d, { partyId: party.id, course: nextCourse }, 'human'))
                }
              >
                Fire {nextCourse ?? 'course'}
              </button>
              <button
                className="tbtn tbtn--no"
                disabled={!party}
                onClick={() => act((d) => clearTable(d, { tableId: table.id }, 'human'))}
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// --- 2. A station ------------------------------------------------------------

export function StationPane({ sous, select, station }: PaneProps & { station: Station }) {
  const { state } = sous;
  const menu = new Map(state.menu.map((m) => [m.id, m]));
  const tableOf = (partyId: string) => {
    const p = state.parties.find((x) => x.id === partyId);
    return state.plan.tables.find((t) => t.id === p?.tableId)?.name ?? p?.name ?? '—';
  };
  const rows = state.tickets.flatMap((t) =>
    t.items
      .filter((i) => i.status !== 'served' && menu.get(i.menuItemId)?.stationType === station.type)
      .map((i) => ({ t, i, m: menu.get(i.menuItemId)! })),
  );
  const cooking = rows.filter((r) => r.i.status === 'cooking').length;
  const queued = rows.filter((r) => r.i.status === 'queued').length;
  const off = state.menu.filter((m) => m.stationType === station.type && m.is86d);

  return (
    <>
      <div className="block">
        <button className="back" onClick={() => select(null)}>← All tables</button>
        <div className="detailHead">
          <div>
            <h2>{station.name}</h2>
            <p>{station.concurrency} at once</p>
          </div>
          <span className="tag">{queued > 0 ? 'Backed up' : 'Clear'}</span>
        </div>
      </div>

      <div className="block">
        <Stats
          rows={[
            ['COOKING', `${cooking} of ${station.concurrency}`],
            ['WAITING', String(queued)],
            ['HEADROOM', String(Math.max(0, station.concurrency - cooking))],
            ['ON THIS PASS', String(rows.length)],
          ]}
        />
      </div>

      <div className="block">
        <span className="eyebrow">ON THE STOVE</span>
        {rows.length === 0 ? (
          <p className="said">Nothing routed here right now.</p>
        ) : (
          <ul className="sections">
            {rows.map(({ t, i, m }) => (
              <li key={`${t.id}-${i.menuItemId}`}>
                <span>{tableOf(t.partyId)} · {i.qty}× {m.name}</span>
                <span>
                  {i.status === 'cooking' && i.startedAt !== null
                    ? `${Math.max(0, i.startedAt + m.cookMinutes - state.shift.clock)} min left`
                    : sentence(i.status)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="block">
        <span className="eyebrow">86'D HERE</span>
        {off.length === 0 ? (
          <p className="said">Everything on this station is on.</p>
        ) : (
          <ul className="sections">
            {off.map((m) => (
              <li key={m.id}>
                <span>{m.name}</span>
                <span>{m.course}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

// --- 3. The pass: every in-flight ticket -------------------------------------

export function TicketPane({ sous, act, select }: PaneProps) {
  const { state } = sous;
  const { clock } = state.shift;
  const menu = new Map(state.menu.map((m) => [m.id, m]));
  const inFlight = (t: { items: { status: string }[] }) => !t.items.every((i) => i.status === 'served');
  // Served tickets stay in state so the night has a history. The pass is what is still
  // moving, which is also what get_tickets means by "in flight" (§4).
  const tickets = state.tickets.filter(inFlight).sort((a, b) => a.dueAt - b.dueAt);
  const tableOf = (partyId: string) => {
    const p = state.parties.find((x) => x.id === partyId);
    return state.plan.tables.find((t) => t.id === p?.tableId)?.name ?? p?.name ?? '—';
  };
  const late = tickets.filter((t) => t.dueAt < clock);

  return (
    <>
      <div className="block">
        <button className="back" onClick={() => select(null)}>← All tables</button>
        <div className="detailHead">
          <div>
            <h2>The Pass</h2>
            <p>Every ticket in flight, earliest due first</p>
          </div>
          <span className="tag">{tickets.length} open</span>
        </div>
      </div>

      <div className="block">
        <Stats
          rows={[
            ['IN FLIGHT', String(tickets.length)],
            ['LATE', String(late.length)],
          ]}
        />
      </div>

      {tickets.length === 0 ? (
        <div className="block">
          <p className="said">Nothing fired. The pass is clear.</p>
        </div>
      ) : (
        tickets.map((t) => {
          const over = clock - t.dueAt;
          return (
            <div className="block" key={t.id}>
              <div className="ticketHead">
                <strong>{tableOf(t.partyId)} · {t.course}</strong>
                <span className={`chip${over > 0 ? ' chip--warn' : ''}`}>
                  {over > 0 ? `${over} min late` : `due ${fmtClock(t.dueAt)}`}
                </span>
              </div>
              <ul className="sections">
                {t.items.map((i) => (
                  <li key={i.menuItemId}>
                    <span>{i.qty}× {menu.get(i.menuItemId)?.name}</span>
                    <span>{i.status}</span>
                    {i.status === 'queued' && (
                      <button
                        className="tbtn tbtn--sm"
                        title="Drop this line"
                        onClick={() =>
                          act((d) => swapTicketItem(d, { ticketId: t.id, menuItemId: i.menuItemId }, 'human'))
                        }
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="actions">
                {[-5, 5].map((by) => (
                  <button
                    key={by}
                    className="tbtn tbtn--sm"
                    onClick={() => act((d) => retimeTicket(d, { ticketId: t.id, byMinutes: by }, 'human'))}
                  >
                    {by < 0 ? '− 5 min' : '+ 5 min'}
                  </button>
                ))}
                <span className="hint">fired {fmtClock(t.firedAt)} by {t.provenance}</span>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}

// --- 4. The host stand: tonight's book, the list, the door -------------------

export function HostPane({ sous, act, select }: PaneProps) {
  const { state } = sous;
  const { clock } = state.shift;
  const book = [...state.reservations].sort((a, b) => a.time - b.time);
  const seatSomeone = (ref: { reservationId?: string; waitId?: string }, size: number) =>
    act((d) => {
      const t = pickTable(d, size);
      return t
        ? seatParty(d, { ...ref, tableIds: [t.id] }, 'human')
        : refuse(`Nothing free seats ${size} right now. Quote a wait, or combine two tables.`);
    });

  return (
    <>
      <div className="block">
        <button className="back" onClick={() => select(null)}>← All tables</button>
        <div className="detailHead">
          <div>
            <h2>Host Stand</h2>
            <p>Tonight's book, the list and the door</p>
          </div>
          <span className="tag">{state.waitlist.length} waiting</span>
        </div>
      </div>

      <div className="block">
        <span className="eyebrow">WALK-IN</span>
        <form
          className="field"
          onSubmit={(e) => {
            const f = fields(e);
            const name = f('name');
            const size = Number(f('size'));
            act((d) => addToWaitlist(d, { name, size }, 'human'));
          }}
        >
          <input name="name" placeholder="Name" maxLength={40} required />
          <input name="size" type="number" min={1} max={20} defaultValue={2} required />
          <button className="tbtn tbtn--sm" type="submit">Add</button>
        </form>
      </div>

      <div className="block">
        <span className="eyebrow">WAITLIST</span>
        {state.waitlist.length === 0 ? (
          <p className="said">Nobody at the door.</p>
        ) : (
          <ul className="sections">
            {state.waitlist.map((w) => (
              <li key={w.id}>
                <span>{w.name} · {w.size}</span>
                <span>
                  waiting {clock - w.addedAt}m
                  {w.quotedMinutes ? ` · quoted ${w.quotedMinutes}m` : ''}
                </span>
                <button className="tbtn tbtn--sm" onClick={() => seatSomeone({ waitId: w.id }, w.size)}>
                  Seat
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="block">
        <span className="eyebrow">RESERVATIONS</span>
        <ul className="sections">
          {book.map((r) => (
            <li key={r.id}>
              <span>{fmtClock(r.time)} · {r.name} · {r.size}</span>
              <span>{r.status}</span>
              {r.status !== 'seated' && r.status !== 'no-show' && (
                <button className="tbtn tbtn--sm" onClick={() => seatSomeone({ reservationId: r.id }, r.size)}>
                  Seat
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// --- 5. A section ------------------------------------------------------------

export function SectionPane({ sous, select, section }: PaneProps & { section: Section }) {
  const { state } = sous;
  const held = new Map(
    liveParties(state).flatMap((p) => [p.tableId, ...p.joinedIds].filter(Boolean).map((id) => [id as string, p])),
  );
  const tables = section.tableIds
    .map((id) => state.plan.tables.find((t) => t.id === id))
    .filter((t): t is Table => !!t);
  const capacity = tables.reduce((n, t) => n + t.seats, 0);
  const seated = tables.reduce((n, t) => n + (held.get(t.id)?.tableId === t.id ? held.get(t.id)!.size : 0), 0);
  const mine = sous.conflicts.filter((c) => c.targetId === section.id);

  return (
    <>
      <div className="block">
        <button className="back" onClick={() => select(null)}>← All tables</button>
        <div className="detailHead">
          <div>
            <h2>{section.name}</h2>
            <p>{section.serverName}</p>
          </div>
          <span className="swatch" style={{ background: `var(${section.color})` }} />
        </div>
      </div>

      <div className="block">
        <Stats
          rows={[
            ['TABLES', String(tables.length)],
            ['CAPACITY', `${capacity} covers`],
            ['SEATED', `${seated} covers`],
            ['OPEN', String(tables.filter((t) => !held.has(t.id)).length)],
          ]}
        />
      </div>

      <div className="block">
        <span className="eyebrow">TABLES</span>
        <ul className="sections">
          {tables.map((t) => {
            const p = held.get(t.id);
            return (
              <li key={t.id}>
                <button className="chip" onClick={() => select(t.id)}>{t.name}</button>
                <span>{p ? `${p.name} · ${p.size}` : 'open'}</span>
                <span>{t.seats} seats</span>
              </li>
            );
          })}
        </ul>
      </div>

      {mine.length > 0 && (
        <div className="block">
          <span className="eyebrow">FLAGS</span>
          <ul className="issues">
            {mine.map((c, i) => (
              <li key={`${c.type}-${i}`}>
                <span className={`chip chip--${c.severity}`}>{c.type}</span>
                <span>{c.message}{c.suggestion ? <em> {c.suggestion}</em> : null}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// --- 6. Empty floor: the room, the conflicts, the notes, design controls ------

export function FloorPane({ sous, act, select }: PaneProps) {
  const { state, conflicts } = sous;
  const { plan, shift, reservations, menu } = state;
  const design = shift.mode === 'design';
  const seats = plan.tables.reduce((n, t) => n + t.seats, 0);
  const booked = reservations.reduce((n, r) => n + r.size, 0);
  const open = state.notes.filter((n) => n.createdAt <= shift.clock && n.status === 'open');
  const focusOn = (targetId: string) =>
    select(plan.tables.some((t) => t.id === targetId) ? targetId : null);

  return (
    <>
      <div className="block">
        <span className="eyebrow">ROOM</span>
        <Stats
          rows={[
            ['TABLES', String(plan.tables.length)],
            ['SEATS', String(seats)],
            ['BOOKED', `${booked} covers`],
            ['RESERVATIONS', String(reservations.length)],
            ['MENU', `${menu.length} items`],
            ['SEED', String(shift.seed)],
          ]}
        />
      </div>

      {design && (
        <div className="block">
          <span className="eyebrow">DESIGN</span>
          <form
            className="field"
            onSubmit={(e) => {
              const f = fields(e);
              const seatCount = Number(f('seats'));
              const anchor = f('anchor') as (typeof ANCHORS)[number];
              act((d) => addTable(d, { seats: seatCount, anchor }, 'human'));
            }}
          >
            <input name="seats" type="number" min={1} max={12} defaultValue={2} required />
            <select name="anchor" defaultValue="centre">
              {ANCHORS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button className="tbtn tbtn--sm" type="submit">Add table</button>
          </form>

          <form
            className="field"
            onSubmit={(e) => {
              const f = fields(e);
              const template = f('template') as 'bistro' | 'banquet' | 'communal';
              const covers = Number(f('covers'));
              act((d) => applyLayoutTemplate(d, { template, covers }, 'human'));
            }}
          >
            <select name="template" defaultValue="bistro">
              {['bistro', 'banquet', 'communal'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input name="covers" type="number" min={8} max={200} step={4} defaultValue={60} required />
            <button className="tbtn tbtn--sm" type="submit">Lay out</button>
          </form>
          <p className="hint">Pinned tables stay where they are.</p>
        </div>
      )}

      <div className="block">
        <span className="eyebrow">CONFLICTS</span>
        {conflicts.length === 0 ? (
          <p className="said">Nothing to fix. The same engine checks the layout and the service board.</p>
        ) : (
          <ul className="issues">
            {conflicts.map((c, i) => (
              <li key={`${c.type}-${c.targetId}-${i}`}>
                <button className={`chip chip--${c.severity}`} onClick={() => focusOn(c.targetId)}>
                  {c.type}
                </button>
                <span>{c.message}{c.suggestion ? <em> {c.suggestion}</em> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="block">
        <span className="eyebrow">SERVICE NOTES</span>
        {open.length === 0 ? (
          <p className="said">No open notes.</p>
        ) : (
          open.map((n) => (
            <div className="note" key={n.id}>
              <p>
                <button className="chip" onClick={() => n.tableId && select(n.tableId)}>
                  {n.tableId ?? 'floor'}
                </button>{' '}
                {n.text}
              </p>
              <form
                className="field"
                onSubmit={(e) => {
                  const f = fields(e);
                  const response = f('response');
                  act((d) => resolveNote(d, { noteId: n.id, response }, 'human'));
                }}
              >
                <input name="response" placeholder={`How was the ${n.from}'s note handled?`} maxLength={240} required />
                <button className="tbtn tbtn--sm" type="submit">Close</button>
              </form>
            </div>
          ))
        )}
      </div>

      <div className="block">
        <span className="eyebrow">SECTIONS</span>
        <ul className="sections">
          {plan.sections.map((s) => (
            <li key={s.id}>
              <span className="swatch" style={{ background: `var(${s.color})` }} />
              <button className="chip" onClick={() => select(s.id)}>{s.name}</button>
              <span>{s.tableIds.length} tables · {s.serverName}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

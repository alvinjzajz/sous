// The six detail panes (SOUS_PLAN.md §1). The canvas is the hub, these are the spokes,
// and each one maps onto a tool group — so day 5's tools read the state a pane already
// reads and call the mutation a button already calls (CLAUDE.md #5).
//
// EVERY elapsed number here is derived against shift.clock and never stored (CLAUDE.md
// #2). "23 min on table" recomputes every frame, which is what stops undo resurrecting
// a stale countdown.
//
// The forms are plain <form> + FormData and the override confirm is a native <dialog>,
// so the only useState in this file is which conflict that dialog is asking about.
import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  addReservation, addTable, addToWaitlist, applySavedLayout, assignReservation, assignSection, clearTable,
  deliverTicket, fireCourse, overrideConflict, removeTable, reshape, resolveNote,
  restoreConflict, retimeTicket, seatParty, setItem86, setPin, swapTicketItem, updateTable,
} from './mutations.ts';
import { conflictKey } from './conflicts.ts';
import { deleteLayout, listLayouts, readLayout, saveLayout } from './layouts.ts';
import type { Reshape, Result } from './mutations.ts';
import { inWindow, openBookings, pickTable, ticketPlatedAt } from './sim.ts';
import type { Sous } from './store.ts';
import { CELL_M, fmtClock } from './types.ts';
import type {
  Conflict, MenuCourse, Party, Reservation, Section, SousState, Station, Table, WaitEntry,
} from './types.ts';

export interface PaneProps {
  sous: Sous;
  /** The mutation path. Everything a person clicks goes through here. */
  act: (fn: (draft: SousState) => Result<unknown>) => void;
  select: (id: string | null) => void;
}

const COURSES: MenuCourse[] = ['drinks', 'apps', 'mains', 'dessert'];

/**
 * Selection id for the menu pane. The menu is a registry, not a thing in the room, so
 * unlike a table or a station it has no node to click — this is the same sentinel route
 * HOST_ID takes, and App's membership chain resolves it exactly the same way.
 */
export const MENU_ID = 'menu';
const RESHAPES: { kind: Reshape; label: string }[] = [
  { kind: 'rotate', label: 'Rotate 90°' },
  { kind: 'grow', label: 'Grow' },
  { kind: 'shrink', label: 'Shrink' },
  { kind: 'widen', label: 'Widen' },
];

/**
 * The mockup's MODELS grid. Every tile maps onto real domain state — a seat count and a
 * shape that `addTable` already understands — so there is nothing here the tools cannot
 * also express. The mockup's Booth, Wall, Door and Planter tiles are deliberately absent:
 * there is no booth in the model, and walls are §8's deferred `addWall`, so shipping them
 * would be drawing furniture the app cannot actually hold.
 */
const MODELS: { label: string; seats: number; shape: Table['shape'] }[] = [
  { label: '2-top', seats: 2, shape: 'rect' },
  { label: '4-top', seats: 4, shape: 'rect' },
  { label: 'Round 2', seats: 2, shape: 'round' },
  { label: 'Round 4', seats: 4, shape: 'round' },
  { label: '6-top', seats: 6, shape: 'rect' },
  { label: '8-top', seats: 8, shape: 'rect' },
];

/** A table seen from above with its chairs, drawn to the tile. Decorative, not to scale. */
function ModelIcon({ seats, shape }: { seats: number; shape: Table['shape'] }) {
  const w = shape === 'round' ? 18 : 12 + seats * 3;
  const h = shape === 'round' ? 18 : 14;
  const perSide = shape === 'round' ? 1 : Math.ceil(seats / 2);
  const spread = (i: number, n: number) => 20 + ((i + 1) * w) / (n + 1) - w / 2;
  return (
    <svg viewBox="0 0 40 34" width="40" height="34" aria-hidden="true" focusable="false">
      {Array.from({ length: perSide }, (_, i) => (
        <g key={i} fill="currentColor" opacity="0.65">
          <rect x={spread(i, perSide) - 2.5} y={17 - h / 2 - 4} width="5" height="2.5" rx="1" />
          <rect x={spread(i, perSide) - 2.5} y={17 + h / 2 + 1.5} width="5" height="2.5" rx="1" />
        </g>
      ))}
      {shape === 'round' && (
        <g fill="currentColor" opacity="0.65">
          <rect x={20 - w / 2 - 4} y="14.5" width="2.5" height="5" rx="1" />
          <rect x={20 + w / 2 + 1.5} y="14.5" width="2.5" height="5" rx="1" />
        </g>
      )}
      {shape === 'round' ? (
        <circle cx="20" cy="17" r={w / 2} fill="none" stroke="currentColor" strokeWidth="1.6" />
      ) : (
        <rect
          x={20 - w / 2} y={17 - h / 2} width={w} height={h} rx="1.5"
          fill="none" stroke="currentColor" strokeWidth="1.6"
        />
      )}
    </svg>
  );
}

const sentence = (v: string) => v[0].toUpperCase() + v.slice(1);
const roomM = (n: number) => +(n * CELL_M).toFixed(1);
const refuse = (message: string): Result<never> => ({ ok: false, message });

// The value is a ReactNode, not a string, so one stat can be the way into another pane
// (the FLOOR pane's MENU count opens the menu) without a second layout for one row.
function Stats({ rows }: { rows: [string, ReactNode][] }) {
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

/**
 * One seat up or down, counted from the DRAFT rather than from the rendered table.
 * React batches clicks, so two taps of "+" in the same tick would otherwise both read
 * the same rendered seat count and the second would be a no-op.
 */
function bumpSeats(d: SousState, tableId: string, by: number) {
  const t = d.plan.tables.find((x) => x.id === tableId);
  if (!t) return refuse(`There is no table ${tableId}.`);
  return updateTable(d, { tableId, seats: t.seats + by }, 'human');
}

/**
 * Tonight's book. Same card as the waitlist, because a host reads them the same way —
 * who, how many, when — and the only difference is the verb on the button.
 */
export function BookingRows({
  entries, clock, action, nameOf, brief = false,
}: {
  entries: Reservation[];
  clock: number;
  /** Assign in the list, Seat once one is held. Omitted in the left rail. */
  action?: (r: Reservation) => { label: string; onClick: () => void; disabled: boolean; title: string };
  /** Resolves a held table id to its name, so a booking shows where it is going. */
  nameOf?: (id: string) => string;
  brief?: boolean;
}) {
  if (!entries.length) return <p className="hint">Nothing in the book.</p>;
  return (
    <ul className="waits">
      {entries.map((r) => {
        const act = action?.(r);
        const late = r.status === 'arrived' ? clock - r.time : 0;
        return (
          <li key={r.id} className={late > 0 ? 'wait--over' : undefined}>
            <div>
              <strong>{r.name} · {r.size}</strong>
              <span>
                {fmtClock(r.time)} · {r.status}
                {late > 0 ? ` · standing ${late}m` : ''}
                {r.tableId ? ` · held for ${nameOf?.(r.tableId) ?? r.tableId}` : ''}
                {!brief && r.notes ? ` · ${r.notes}` : ''}
              </span>
            </div>
            {act && (
              <button className="tbtn tbtn--seat" onClick={act.onClick} disabled={act.disabled} title={act.title}>
                {act.label}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The people at the door.
 *
 * This replaced the `quote-blown` conflict rule. A blown quote is not a fault in the
 * board — it is just the state of the door, it fires on every busy night, and no edit
 * could ever clear it, so it only ever drowned the strip. The wait against the quote
 * belongs on the party it describes, where somebody can act on it.
 */
export function WaitRows({
  entries, clock, seat, brief = false,
}: {
  entries: WaitEntry[];
  clock: number;
  /** Omitted in the left rail, where there is no table to seat anybody at. */
  seat?: (w: WaitEntry) => { onClick: () => void; disabled: boolean; title: string };
  /** The 186px left rail: the wait, without the quote it is measured against. */
  brief?: boolean;
}) {
  if (!entries.length) return <p className="hint">Nobody at the door.</p>;
  return (
    <ul className="waits">
      {entries.map((w) => {
        const waited = clock - w.addedAt;
        const over = waited > w.quotedMinutes;
        const action = seat?.(w);
        return (
          <li key={w.id} className={over ? 'wait--over' : undefined}>
            <div>
              <strong>{w.name} · {w.size}</strong>
              <span>
                {brief
                  ? `waiting ${waited}m${over ? ` · ${waited - w.quotedMinutes}m over` : ''}`
                  : `waiting ${waited}m · quoted ${w.quotedMinutes}m${over ? ` · ${waited - w.quotedMinutes}m over` : ''}`}
              </span>
            </div>
            {action && <button className="tbtn tbtn--seat" {...action}>Seat</button>}
          </li>
        );
      })}
    </ul>
  );
}

// --- 1. A table --------------------------------------------------------------

export function TablePane({ sous, act, select, table }: PaneProps & { table: Table }) {
  const { plan, shift, tickets, menu } = sous.state;
  const party = liveParties(sous.state)
    .find((p) => p.tableId === table.id || p.joinedIds.includes(table.id)) ?? null;
  const section = plan.sections.find((s) => s.tableIds.includes(table.id));
  const design = shift.mode === 'design';
  const pinned = table.pinned || !!party?.pinned;
  // Two states, as asked for: the book, with an Assign on each row; or the one booking
  // this table is being held for, with a Seat. Assigning is a promise about where they
  // will go; seating is what happens when they walk in.
  const held = sous.state.reservations.find(
    (r) => r.tableId === table.id && r.status !== 'seated' && r.status !== 'no-show',
  ) ?? null;
  const bookable = openBookings(sous.state).filter((r) => !r.tableId);
  const seatHere = (ref: { reservationId?: string; waitId?: string }) =>
    act((d) => seatParty(d, { ...ref, tableIds: [table.id] }, 'human'));
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
          <span className="eyebrow">TOOLS</span>
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
                  onClick={() =>
                    args && act((d) => {
                      // Recompute against the DRAFT. Two clicks inside one React batch
                      // both see the same rendered `table`, so the second was a no-op.
                      const live = d.plan.tables.find((x) => x.id === table.id);
                      const next = live && reshape(live, kind, d.plan.gridSize);
                      return next ? updateTable(d, next, 'human') : refuse(`${label} does not apply to ${table.name}.`);
                    })
                  }
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

          <p className="hint">
            {pinned
              ? `${table.name} is pinned. Unpin it to move it.`
              : `Editing ${table.name}. Drag it on the plan to reposition.`}
          </p>

          {/* SEATS ARE NOT DERIVED FROM SIZE. Grow and Shrink change the footprint; how
              many covers the table takes is a judgement made here (the mockup's
              "SELECTED TABLE / Seats - 4 +"). */}
          <div className="field">
            <span className="eyebrow">SEATS</span>
            <div className="stepper">
              <button
                className="tbtn tbtn--sm"
                disabled={table.seats <= 1}
                aria-label="One seat fewer"
                onClick={() => act((d) => bumpSeats(d, table.id, -1))}
              >
                −
              </button>
              <b>{table.seats}</b>
              <button
                className="tbtn tbtn--sm"
                disabled={table.seats >= 12}
                aria-label="One seat more"
                onClick={() => act((d) => bumpSeats(d, table.id, +1))}
              >
                +
              </button>
            </div>
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
            <p className="said">Open. Nobody is sitting here.</p>
          )}
        </div>
      )}

      {/* An empty table in service is a question — WHO GOES HERE — so the pane answers
          it with the two lists a host actually reads (the mockup's "NEXT ON THIS TABLE"
          and "SEAT FROM WAITLIST"), instead of one button that picked for you. */}
      {!design && !party && (
        <>
          <div className="block">
            <span className="eyebrow">RESERVED</span>
            {held ? (
              <>
                <BookingRows
                  entries={[held]}
                  clock={shift.clock}
                  action={() => ({
                    label: 'Seat',
                    disabled: false,
                    title: `Seat ${held.name} at ${table.name}`,
                    onClick: () => seatHere({ reservationId: held.id }),
                  })}
                />
                <button
                  className="back"
                  onClick={() => act((d) => assignReservation(d, { reservationId: held.id }, 'human'))}
                >
                  ← Let {table.name} go
                </button>
              </>
            ) : (
              <BookingRows
                entries={bookable}
                clock={shift.clock}
                action={(r) => ({
                  label: 'Assign',
                  disabled: r.size > table.seats,
                  title: r.size > table.seats
                    ? `${table.name} seats ${table.seats}; ${r.name} is ${r.size}.`
                    : `Hold ${table.name} for ${r.name}`,
                  onClick: () => act((d) => assignReservation(d, { reservationId: r.id, tableId: table.id }, 'human')),
                })}
              />
            )}
          </div>

          <div className="block">
            <span className="eyebrow">SEAT FROM WAITLIST</span>
            <WaitRows
              entries={sous.state.waitlist}
              clock={shift.clock}
              seat={(w) => ({
                disabled: w.size > table.seats,
                title: w.size > table.seats
                  ? `${table.name} seats ${table.seats}; ${w.name} is ${w.size}.`
                  : `Seat ${w.name} at ${table.name}`,
                onClick: () => seatHere({ waitId: w.id }),
              })}
            />
          </div>
        </>
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
                disabled={!party || !nextCourse}
                title="Ring the course in and let the kitchen compose the order"
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

        {!design && party && nextCourse && (
          <OrderPicker sous={sous} act={act} party={party} course={nextCourse} />
        )}
      </div>
    </>
  );
}

/**
 * The human half of order entry — mockup feature 3, §8's conditional one.
 *
 * Deliberately the SAME call the agent makes: it builds `[{menuItemId, qty}]` and hands
 * it to `fireCourse`, which is exactly `fire_course({ items })`. Until now that parameter
 * was agent-only in practice — the Fire button rang the course in and let `compose()`
 * invent the order — so the agent could choose the dishes and the person could not. §9's
 * 1:55 beat is built on that parameter, which made the gap one a judge would watch.
 *
 * Not the mockup's cart: a `<details>` beside the Fire button, listing only the NEXT
 * course's dishes, with a number input each. Submitting with everything at 0 sends no
 * `items` at all, so the one-click path is untouched — the picker is strictly additive.
 *
 * No local state: a plain <form> plus FormData, which is the platform doing what a
 * useState-per-row would (the day-4 rule for every form in this file). 86'd dishes are
 * disabled here because `checkItems` refuses them at the boundary anyway — the input is
 * the reminder, the mutation is the gate.
 */
function OrderPicker({
  sous, act, party, course,
}: Pick<PaneProps, 'sous' | 'act'> & { party: Party; course: MenuCourse }) {
  const items = sous.state.menu.filter((m) => m.course === course);
  return (
    <details className="picker">
      <summary>Choose dishes</summary>
      <form
        onSubmit={(e) => {
          const f = fields(e);
          const order = items
            .map((m) => ({ menuItemId: m.id, qty: Number(f(m.id) || 0) }))
            .filter((line) => line.qty > 0);
          act((d) =>
            fireCourse(
              d,
              // No line chosen means "you decide", which is the button's own behaviour.
              { partyId: party.id, course, items: order.length ? order : undefined },
              'human',
            ),
          );
        }}
      >
        <ul className="pickList">
          {items.map((m) => (
            <li key={m.id} className={m.is86d ? 'is86' : undefined}>
              <label htmlFor={`q-${m.id}`}>{m.name}</label>
              <span className="menuMeta">{m.cookMinutes} min · ${m.price}</span>
              <input
                id={`q-${m.id}`}
                name={m.id}
                type="number"
                min={0}
                max={12}
                defaultValue={0}
                disabled={m.is86d}
                aria-label={`${m.name}, how many`}
              />
            </li>
          ))}
        </ul>
        <div className="actions">
          <button className="tbtn" type="submit">Fire {course}</button>
          <span className="hint">Leave every line at 0 and the kitchen composes it.</span>
        </div>
      </form>
    </details>
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
  // The same predicate the floor's pass block and check-sim use, so the number on the
  // board, the button here and the check can never disagree.
  const upNow = new Set(inWindow(state).map((t) => t.id));

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
            ['IN THE WINDOW', String(upNow.size)],
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
          const up = upNow.has(t.id);
          // Time in the window, DERIVED against the clock, never stored (CLAUDE.md #2).
          // This is what replaced the `plate-dying` conflict rule, which was designed and
          // then cut because completeItems auto-serves at exactly plated + RUNNER_MIN, so
          // the condition could never fire. The information still matters; it just is not
          // a fault, so it belongs on the ticket rather than in the conflicts strip.
          const sat = up ? Math.max(0, clock - (ticketPlatedAt(t, menu) ?? clock)) : 0;
          return (
            <div className="block" key={t.id}>
              <div className="ticketHead">
                <strong>{tableOf(t.partyId)} · {t.course}</strong>
                <span className={`chip${over > 0 ? ' chip--warn' : ''}`}>
                  {over > 0 ? `${over} min late` : `due ${fmtClock(t.dueAt)}`}
                </span>
                {/* A SECOND chip, not a replacement: "late" and "sitting in the window"
                    are different facts and a ticket is regularly both. Sitting time can
                    only ever reach RUNNER_MIN - 1, because completeItems auto-serves at
                    exactly plated + RUNNER_MIN — which is the window you are beating. */}
                {up && (
                  <span className="chip chip--warn">
                    {sat === 0 ? 'just up' : `${sat} min in the window`}
                  </span>
                )}
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
                {/* The human half of deliver_ticket, which shipped on day 5 with no
                    button anywhere. Disabled rather than hidden while the kitchen still
                    has the course, carrying the mutation's OWN refusal sentence — one
                    message, both surfaces (CLAUDE.md #5). */}
                <button
                  className="tbtn"
                  disabled={!up}
                  title={up ? 'Run this course to the table now' : 'Still in the kitchen — a course goes out together or not at all'}
                  onClick={() => act((d) => deliverTicket(d, { ticketId: t.id }, 'human'))}
                >
                  Deliver
                </button>
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

// --- 3b. The menu: what is on tonight, and what is off ----------------------
//
// setItem86 was the ONE service mutation with no human button anywhere: the agent could
// 86 the salmon (§9, 1:55) and the person at the keyboard could not, which is the exact
// asymmetry this submission argues against. The station pane listed what was off and
// could not change it.
//
// Not on the floor, so not clickable there — it reaches the pane through MENU_ID, the
// same sentinel-id route the host stand already takes.

export function MenuPane({ sous, act, select }: PaneProps) {
  const { state } = sous;
  const off = state.menu.filter((m) => m.is86d);
  // The board's live load, so 86'ing something busy reads as the trade it is.
  const onTickets = new Map<string, number>();
  for (const t of state.tickets) {
    for (const i of t.items) {
      if (i.status === 'served') continue;
      onTickets.set(i.menuItemId, (onTickets.get(i.menuItemId) ?? 0) + 1);
    }
  }

  return (
    <>
      <div className="block">
        <button className="back" onClick={() => select(null)}>← All tables</button>
        <div className="detailHead">
          <div>
            <h2>The Menu</h2>
            <p>{state.menu.length} dishes · {off.length} off tonight</p>
          </div>
          <span className="tag">{off.length === 0 ? 'All on' : `${off.length} 86'd`}</span>
        </div>
      </div>

      {COURSES.map((course) => {
        const items = state.menu.filter((m) => m.course === course);
        if (items.length === 0) return null;
        return (
          <div className="block" key={course}>
            <span className="eyebrow">{course.toUpperCase()}</span>
            <ul className="menuList">
              {items.map((m) => {
                const live = onTickets.get(m.id) ?? 0;
                return (
                  <li key={m.id} className={m.is86d ? 'is86' : undefined}>
                    <span className="menuName">{m.name}</span>
                    <span className="menuMeta">
                      {m.stationType} · {m.cookMinutes} min · ${m.price}
                      {live > 0 ? ` · on ${live} ticket${live > 1 ? 's' : ''}` : ''}
                    </span>
                    <button
                      className={`tbtn tbtn--sm${m.is86d ? '' : ' tbtn--no'}`}
                      aria-pressed={m.is86d}
                      title={
                        m.is86d
                          ? `Put ${m.name} back on`
                          : live > 0
                            ? `86 it — ${live} open ticket${live > 1 ? 's' : ''} still carry it`
                            : `Take ${m.name} off for the night`
                      }
                      onClick={() =>
                        act((d) => setItem86(d, { menuItemId: m.id, is86d: !m.is86d }, 'human'))
                      }
                    >
                      {m.is86d ? 'Put back' : '86'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <div className="block">
        <p className="hint">
          86'ing a dish does not clear the tickets already carrying it. The pass shows
          which, and each line can be swapped or dropped there.
        </p>
      </div>
    </>
  );
}

// --- 4. The host stand: tonight's book, the list, the door -------------------

export function HostPane({ sous, act, select }: PaneProps) {
  const { state } = sous;
  const { clock } = state.shift;
  const book = openBookings(state);
  // A held table is where they go. Otherwise the house's own chooser picks, so "seat
  // them somewhere sensible" is one judgement wherever it is made (sim.ts pickTable).
  const seatSomeone = (ref: { reservationId?: string; waitId?: string }, size: number, heldId?: string) =>
    act((d) => {
      const held = heldId ? d.plan.tables.find((t) => t.id === heldId) : null;
      const t = held ?? pickTable(d, size);
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
        <span className="eyebrow">TAKE A BOOKING</span>
        {/* The other half of the door. The seeded book is demo scaffolding that arrives
            when the shift starts and stays out entirely if anyone has written their own
            (sim.ts, openTheBook) — this is how they write their own. A native
            <input type="time"> rather than a picker: §6 says platform first, and it
            gives keyboard entry, locale formatting and validation for nothing. */}
        <form
          className="field field--book"
          onSubmit={(e) => {
            const f = fields(e);
            const name = f('name');
            const size = Number(f('size'));
            const time = f('time');
            const notes = f('notes');
            act((d) => addReservation(d, { name, size, time, notes }, 'human'));
          }}
        >
          <input name="name" placeholder="Name" maxLength={40} required />
          <input name="size" type="number" min={1} max={20} defaultValue={2} required />
          <input name="time" type="time" defaultValue="19:30" required />
          <input name="notes" placeholder="Allergies, occasion…" maxLength={200} />
          <button className="tbtn tbtn--sm" type="submit">Book</button>
        </form>
      </div>

      <div className="block">
        <span className="eyebrow">RESERVATIONS</span>
        <BookingRows
          entries={book}
          clock={clock}
          nameOf={(id) => state.plan.tables.find((t) => t.id === id)?.name ?? id}
          action={(r) => ({
            label: 'Seat',
            disabled: false,
            title: r.tableId ? `Seat ${r.name} at their held table` : `Seat ${r.name}`,
            onClick: () => seatSomeone({ reservationId: r.id }, r.size, r.tableId),
          })}
        />
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
  // Re-read on every render. Saving pushes a line on the rail, which is state, so the
  // list refreshes without a second copy of it living in a useState.
  const saved = listLayouts();
  // The one piece of local state in this file, and it is the right kind: which conflict
  // a confirm dialog is currently asking about is not domain state and must not undo.
  const [pending, setPending] = useState<Conflict | null>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
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
            [
              'MENU',
              <button key="menu" className="statLink" onClick={() => select(MENU_ID)}>
                {menu.length} items ›
              </button>,
            ],
          ]}
        />
      </div>

      {design && (
        <>
          <div className="block">
            <span className="eyebrow">MODELS</span>
            <div className="models">
              {MODELS.map((m) => (
                <button
                  key={m.label}
                  className="model"
                  title={`Add a ${m.label} in the middle of the room, then drag it`}
                  // Lands at the centre — or the nearest clear spot to it, since an
                  // anchor still runs findSpot — and is dragged from there.
                  onClick={() =>
                    act((d) => addTable(d, { seats: m.seats, shape: m.shape, anchor: 'centre' }, 'human'))
                  }
                >
                  <ModelIcon seats={m.seats} shape={m.shape} />
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
            <p className="hint">Drag any unpinned table on the plan to move it.</p>
          </div>

          <div className="block">
            <span className="eyebrow">LAYOUTS</span>
            <form
              className="field"
              onSubmit={(e) => {
                const f = fields(e);
                const r = saveLayout(f('name'), plan);
                sous.say('human', r.ok, r.message);
              }}
            >
              <input name="name" placeholder="Save this room as…" maxLength={40} required />
              <button className="tbtn tbtn--sm" type="submit">Save</button>
            </form>

            {saved.length === 0 ? (
              <p className="said">No saved layouts yet. Save the room and it comes back here.</p>
            ) : (
              <ul className="sections">
                {saved.map((name) => (
                  <li key={name}>
                    <span>{name}</span>
                    <button
                      className="tbtn tbtn--sm"
                      onClick={() => {
                        const layout = readLayout(name);
                        if (!layout) return sous.say('human', false, `The "${name}" layout could not be read back.`);
                        act((d) => applySavedLayout(d, { name, plan: layout }, 'human'));
                      }}
                    >
                      Load
                    </button>
                    <button
                      className="tbtn tbtn--sm tbtn--no"
                      aria-label={`Delete the ${name} layout`}
                      onClick={() => {
                        const r = deleteLayout(name);
                        sous.say('human', r.ok, r.message);
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="hint">Pinned tables survive a load.</p>
          </div>
        </>
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
                <button
                  className="dismiss"
                  title="Override this conflict"
                  aria-label={`Override: ${c.message}`}
                  onClick={() => {
                    setPending(c);
                    confirmRef.current?.showModal();
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {sous.overridden.length > 0 && (
          <>
            <span className="eyebrow eyebrow--sub">OVERRIDDEN BY YOU</span>
            <ul className="issues issues--muted">
              {sous.overridden.map((c, i) => (
                <li key={`${c.type}-${c.targetId}-${i}`}>
                  <button className="chip" onClick={() => focusOn(c.targetId)}>{c.type}</button>
                  <span>{c.message}</span>
                  <button
                    className="dismiss"
                    title="Put it back on the board"
                    aria-label={`Restore: ${c.message}`}
                    onClick={() => act((d) => restoreConflict(d, { key: conflictKey(c) }, 'human'))}
                  >
                    ↺
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Native <dialog> + showModal(): the centring, the backdrop, Esc to close and the
          focus trap are all the platform's. Nothing here re-implements a modal. */}
      <dialog className="confirm" ref={confirmRef} onClose={() => setPending(null)}>
        <h2>Override this conflict?</h2>
        <p className="said">{pending?.message}</p>
        <p className="hint">
          The board will stop raising it until you put it back. Only you can do either —
          the agent cannot override your call, or undo it.
        </p>
        <div className="actions">
          <button className="tbtn" onClick={() => confirmRef.current?.close()}>Cancel</button>
          <button
            className="tbtn tbtn--no"
            onClick={() => {
              if (pending) act((d) => overrideConflict(d, { key: conflictKey(pending) }, 'human'));
              confirmRef.current?.close();
            }}
          >
            Override
          </button>
        </div>
      </dialog>

      {/* Notes are written DURING service, by servers, about parties. There are none
          before the doors open, so the block is service-only. */}
      {!design && (
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
      )}

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

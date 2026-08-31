// The pixel-art floor (SOUS_PLAN.md §6.1), styled to match "../Sous Restaurant Manager.html".
//
// Inline SVG, not absolutely-positioned divs like the mockup: every table is a real
// focusable node, so click handling, focus rings, keyboard nav and screen-reader
// labels come free and set_view can scrollIntoView it later (§6). The mockup's look
// — wood planks, chunky dark edges, bevelled tops, chair blocks — all reproduces with
// patterns and rects, so none of it costs us the accessibility.
//
// The viewBox is measured in CELLS (1 cell = 0.125 m), so one cell is one pixel-art
// pixel. Every coordinate below must stay an integer.
import type { Conflict, FloorPlan as Plan, Party, Table, Wall } from './types.ts';

/**
 * Render units per cell — the pixel-art resolution of the canvas.
 *
 * The DOMAIN stays in cells: 1 cell = 0.125 m, integers only (CLAUDE.md #1), and none
 * of that changes. This is the RENDER grid laid over it, and it is twice as fine, so
 * one pixel-art pixel is HALF a cell. Everything in this file may therefore use halves
 * — a 0.5-cell stroke is exactly one whole render pixel — which is what lets the floor
 * carry the mockup's finer detail and smaller labels without moving a single table.
 */
const PX = 2;

/** Wall thickness, in cells. */
const WALL = 2;
/** Chair block size and its gap from the table edge, in cells. */
const CHAIR = 2.5;
/** Chairs sit flush to the aisle: at 8-10 cells between tables, any more overlaps. */
const CHAIR_GAP = 1;
/** Cells per station concurrency slot: a 2-cell block plus a 1-cell gap. */
const SLOT_PITCH = 3;
/** Corner notch, in cells. The mockup's signature — square objects are never square. */
const NOTCH = 0.5;
/**
 * Pixel size of a ROUND table, in cells — deliberately coarser than the PX render grid
 * the rest of the floor uses, so circles read as chunky pixel art rather than as discs.
 * A four-top at 10 cells across becomes a 5-pixel-radius circle.
 */
const ROUND_PX = 1;
/** Top of the dining floor: below the kitchen line and its wall. */
const FLOOR_TOP = 22;

/**
 * The host stand is a LABEL and a hit target, not modelled furniture: it is not in
 * plan.stations, so computeConflicts never sees it.
 * ponytail: a real host stand is an obstruction and would need aisle clearance like any
 * other box. Ceiling — a table can be placed over it. Same call as chairs-as-obstructions
 * (check-seed.ts): modelling it means re-spacing the seeded room, which is day 1 work.
 * Upgrade is a Station with a footprint plus the re-space.
 */
export const HOST_ID = 'host';

const WALL_FILL: Record<Wall['kind'], string> = {
  wall: 'var(--frame)',
  window: 'var(--sage)',
  door: 'var(--amber)',
};

/** Axis-aligned walls become rects so their edges land on whole cells. */
function wallRect(w: Wall, bounds: Plan['bounds']) {
  const x = Math.min(w.x1, w.x2);
  const y = Math.min(w.y1, w.y2);
  const dx = Math.abs(w.x2 - w.x1);
  const vertical = dx === 0;
  return {
    x: vertical && x === bounds.w ? x - WALL : x,
    y: !vertical && y === bounds.h ? y - WALL : y,
    width: vertical ? WALL : dx,
    height: vertical ? Math.abs(w.y2 - w.y1) : WALL,
  };
}

/** Centre points of each chair block, in integer cells. */
function chairs(t: Table): [number, number][] {
  if (t.shape === 'round') {
    const r = t.w / 2 + CHAIR_GAP + CHAIR / 2;
    return Array.from({ length: t.seats }, (_, i) => {
      const a = (i / t.seats) * Math.PI * 2 - Math.PI / 2;
      return [Math.round(t.x + Math.cos(a) * r), Math.round(t.y + Math.sin(a) * r)] as [number, number];
    });
  }
  // Rect tables seat along the two long edges.
  const top = Math.ceil(t.seats / 2);
  const out: [number, number][] = [];
  for (const [n, y] of [
    [top, t.y - t.h / 2 - CHAIR_GAP - CHAIR / 2],
    [t.seats - top, t.y + t.h / 2 + CHAIR_GAP + CHAIR / 2],
  ] as const) {
    for (let i = 0; i < n; i++) {
      out.push([Math.round(t.x - t.w / 2 + ((i + 1) * t.w) / (n + 1)), Math.round(y)]);
    }
  }
  return out;
}

/**
 * Guests sitting at ONE of the tables a party holds. A combination fills its primary
 * first and spills the rest onto the joined tables, so the room never draws more
 * guests than there are chairs.
 */
function guestsAt(p: Party | undefined, tableId: string, seatsOf: (id: string) => number): number {
  if (!p) return 0;
  let left = p.size;
  for (const id of [p.tableId, ...p.joinedIds]) {
    if (!id) continue;
    const here = Math.min(left, seatsOf(id));
    if (id === tableId) return here;
    left -= here;
  }
  return 0;
}

/**
 * A round table drawn as PIXEL ART: a midpoint circle, whose outline steps in whole
 * ROUND_PX units instead of following a true curve. Round tables are the one thing on
 * the floor drawn at a coarser pixel than everything else — a real circle rendered on
 * the fine grid reads as a smooth disc and loses the register the room is built in.
 *
 * Walks CLOCKWISE FROM 9 O'CLOCK, up over the top. That start point is what makes the
 * top and bottom halves contiguous runs of the same list, so the lit and shadowed
 * bevel rims are slices of the outline rather than a second piece of geometry.
 */
function pixelCircle(cx: number, cy: number, radius: number, step = ROUND_PX) {
  const n = Math.max(1, Math.round(radius / step));
  // Half-width of each pixel row, from the top row down, measured at the row's centre.
  const half = Array.from({ length: 2 * n }, (_, k) => {
    const dy = k - n + 0.5;
    return Math.max(1, Math.round(Math.sqrt(Math.max(0, n * n - dy * dy))));
  });
  const at = (px: number, py: number) => `${cx + px * step},${cy + py * step}`;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let k = n - 1; k >= 0; k--) top.push(at(-half[k], k - n + 1), at(-half[k], k - n));
  for (let k = 0; k < n; k++) top.push(at(half[k], k - n), at(half[k], k - n + 1));
  for (let k = n; k < 2 * n; k++) bottom.push(at(half[k], k - n), at(half[k], k - n + 1));
  for (let k = 2 * n - 1; k >= n; k--) bottom.push(at(-half[k], k - n + 1), at(-half[k], k - n));
  // Two rows of the same width meet at a point each of them named.
  const run = (pts: string[]) => pts.filter((pt, i) => pt !== pts[i - 1]).join(' ');
  return { top: run(top), bottom: run(bottom), ring: run([...top, ...bottom]) };
}

/** A rect with pixel-notched corners, the mockup's PIX_SQ clip-path as a polygon. */
function notched(x: number, y: number, w: number, h: number, n = NOTCH) {
  return [
    [x + n, y], [x + w - n, y], [x + w - n, y + n], [x + w, y + n],
    [x + w, y + h - n], [x + w - n, y + h - n], [x + w - n, y + h], [x + n, y + h],
    [x + n, y + h - n], [x, y + h - n], [x, y + n], [x + n, y + n],
  ].map((pt) => pt.join(',')).join(' ');
}

/** Silkscreen label with the mockup's hard 1-cell drop shadow. */
function PixelText({
  x, y, size, fill, shadow, children,
}: {
  x: number; y: number; size: number; fill: string; shadow: string; children: string;
}) {
  return (
    <>
      <text x={x} y={y + 0.5} fontSize={size} fill={shadow}>{children}</text>
      <text x={x} y={y} fontSize={size} fill={fill}>{children}</text>
    </>
  );
}

interface Props {
  plan: Plan;
  parties: Party[];
  /** Items cooking right now at each station type, from stationLoad(state). */
  cooking?: Record<string, number>;
  /** Items fired and waiting for a slot at each station type. */
  queued?: Record<string, number>;
  /** From computeConflicts. Anything targeting a table or station gets marked. */
  conflicts?: Conflict[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function FloorPlan({
  plan, parties, cooking = {}, queued = {}, conflicts = [], selectedId, onSelect,
}: Props) {
  const { bounds } = plan;
  const sectionOf = new Map(plan.sections.flatMap((s) => s.tableIds.map((id) => [id, s] as const)));
  // A combination shows the same party on every table it holds.
  const partyAt = new Map<string, Party>();
  for (const p of parties) {
    if (!p.tableId) continue;
    for (const id of [p.tableId, ...p.joinedIds]) partyAt.set(id, p);
  }
  const seatsOf = (id: string) => plan.tables.find((t) => t.id === id)?.seats ?? 0;
  /** Worst severity flagged against each id. An error outranks a warning. */
  const flagged = new Map<string, Conflict['severity']>();
  for (const c of conflicts) {
    if (c.severity === 'error' || !flagged.has(c.targetId)) flagged.set(c.targetId, c.severity);
  }

  // width/height give the SVG an INTRINSIC size, which makes it a replaced element:
  // that is what lets CSS fit it inside the stage on both axes without letterboxing —
  // the replaced-element sizing rules re-derive one axis when the other is clamped.
  // A plain div with aspect-ratio does not do that.
  return (
    <svg
      className="floor"
      viewBox={`0 0 ${bounds.w * PX} ${bounds.h * PX}`}
      width={bounds.w * PX}
      height={bounds.h * PX}
      aria-label="Restaurant floor plan"
    >
      <defs>
        {/* Floorboards: planks running top-to-bottom in three tones, butt-jointed
            every 8 cells, with a nail head per board. Mirrors the mockup's layered
            gradient — three plank widths, seams on both axes, dots on a grid. */}
        <pattern id="floorboards" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="var(--floor-1)" />
          <rect x="3" width="3" height="8" fill="var(--floor-2)" />
          <rect x="6" width="2" height="8" fill="var(--floor-3)" />
          <rect y="7.5" width="8" height="0.5" fill="var(--seam)" opacity="0.2" />
          <rect x="7.5" width="0.5" height="7.5" fill="var(--seam)" opacity="0.14" />
          <rect x="1" y="3" width="0.5" height="0.5" fill="var(--seam)" opacity="0.26" />
        </pattern>
        {/* Tabletops get a tighter plank so they read as a separate object. */}
        <pattern id="plank" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="var(--wood)" />
          <rect y="3.5" width="4" height="0.5" fill="var(--wood-dk)" />
        </pattern>
        {/* Back of house is tiled, not boarded. */}
        <pattern id="tile" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="#9e8c72" />
          <rect width="4" height="4" fill="#8e7c63" />
          <rect x="4" y="4" width="4" height="4" fill="#8e7c63" />
        </pattern>
      </defs>

      {/* One scale, applied once. Every coordinate below is still in CELLS. */}
      <g transform={`scale(${PX})`}>
      <rect width={bounds.w} height={bounds.h} fill="url(#tile)" />
      {/* ponytail: no 0.5 m snap-grid overlay — it fights the floor's own nail-head
          grid. `addTable` snaps to plan.gridSize as of day 3, so the overlay would now
          say something true; it is still not drawn because nothing in the UI places a
          table by hand yet. Ceiling — design mode reads as unfinished the moment it gets
          controls. Add it with them (SOUS_PLAN.md §8, conditional day 4), gated on
          design mode, as the mockup does. */}
      <rect
        x={WALL}
        y={FLOOR_TOP}
        width={bounds.w - WALL * 2}
        height={bounds.h - FLOOR_TOP - WALL}
        fill="url(#floorboards)"
      />

      {plan.walls.map((w) => (
        <rect key={w.id} {...wallRect(w, bounds)} fill={WALL_FILL[w.kind]} />
      ))}

      {/* The host stand: the door, plus a few cells of floor inside it, as one target.
          Clicking it opens tonight's book and the waitlist (§1). */}
      {(() => {
        const door = plan.walls.find((w) => w.kind === 'door');
        if (!door) return null;
        const x = Math.min(door.x1, door.x2);
        const w = Math.abs(door.x2 - door.x1);
        const y = bounds.h - WALL - 6;
        const pick = () => onSelect(selectedId === HOST_ID ? null : HOST_ID);
        return (
          <g
            className="table"
            role="button"
            tabIndex={0}
            aria-label="Host stand: tonight's reservations, the waitlist and quoted waits"
            aria-pressed={selectedId === HOST_ID}
            onClick={pick}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                pick();
              }
            }}
          >
            <rect x={x} y={y} width={w} height={6 + WALL} fill="transparent" />
            <PixelText x={x + w / 2} y={y + 3} size={3} fill="var(--select)" shadow="rgba(12,26,20,.55)">
              HOST
            </PixelText>
          </g>
        );
      })()}

      {plan.stations.map((s) => {
        const x = s.x - s.w / 2;
        const y = s.y - s.h / 2;
        const busy = cooking[s.type] ?? 0;
        const waiting = queued[s.type] ?? 0;
        // The pass is a hand-off, not a burner: it gets the ticket rail pane, not slots.
        const slots = s.type === 'pass' ? 0 : s.concurrency;
        // SLOT_PITCH cells per slot, a 2-cell block in each. Integer cells throughout (§6.1).
        const runStart = s.x - Math.round((slots * SLOT_PITCH - 1) / 2);
        const label = [
          s.name,
          slots ? `${busy} of ${s.concurrency} cooking` : `${busy} at the pass`,
          waiting ? `${waiting} waiting for a slot` : null,
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <g
            key={s.id}
            className="table"
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={selectedId === s.id}
            onClick={() => onSelect(selectedId === s.id ? null : s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(selectedId === s.id ? null : s.id);
              }
            }}
          >
            <polygon points={notched(x, y, s.w, s.h)} fill="var(--counter)" stroke="var(--counter-dk)" strokeWidth="0.5" />
            {/* A station with a backlog runs hot. Amber is a fill, never text (§6.1). */}
            {waiting > 0 && <polygon points={notched(x, y, s.w, s.h)} fill="var(--amber)" opacity="0.42" />}
            <rect x={x + 1} y={y + 1} width={s.w - 2} height="0.5" fill="var(--select)" opacity="0.18" />
            <rect x={x + 1} y={y + s.h - 1.5} width={s.w - 2} height="0.5" fill="#0c1a14" opacity="0.4" />
            <PixelText
              x={s.x}
              y={slots ? s.y - 2 : s.y}
              size={3}
              fill="var(--select)"
              shadow="rgba(12,26,20,.55)"
            >
              {s.name.toUpperCase()}
            </PixelText>

            {/* One block per concurrency slot, filled while something is on it. Occupancy
                as a count of filled blocks, so the kitchen reads in greyscale too. */}
            {Array.from({ length: slots }, (_, i) => (
              <rect
                key={i}
                x={runStart + i * SLOT_PITCH}
                y={s.y + 2}
                width="2"
                height="2"
                fill={i < busy ? 'var(--select)' : '#0c1a14'}
                opacity={i < busy ? 1 : 0.38}
              />
            ))}
          </g>
        );
      })}

      {plan.tables.map((t) => {
        const section = sectionOf.get(t.id);
        const party = partyAt.get(t.id);
        const x = t.x - t.w / 2;
        const y = t.y - t.h / 2;
        const r = t.w / 2;
        const round = t.shape === 'round';
        const seated = guestsAt(party, t.id, seatsOf);
        const held = party ? [party.tableId, ...party.joinedIds].filter(Boolean) : [];
        const flag = flagged.get(t.id);
        const label = [
          `Table ${t.name}`,
          `seats ${t.seats}`,
          section ? `${section.name} section` : 'no section',
          party ? `seated: ${party.name}, party of ${party.size}` : 'empty',
          held.length > 1 ? `pushed together with ${held.filter((id) => id !== t.id).join(' and ')}` : null,
          t.pinned || party?.pinned ? 'pinned' : null,
          flag ? `${flag === 'error' ? 'conflict' : 'warning'}` : null,
          `placed by ${t.provenance}`,
        ]
          .filter(Boolean)
          .join(', ');

        /** Same footprint, drawn repeatedly: top, section tint, provenance ring. */
        const footprint = (props: Record<string, string | number>, grow = 0) =>
          round ? (
            <polygon points={pixelCircle(t.x, t.y, r + grow).ring} {...props} />
          ) : (
            <polygon points={notched(x - grow, y - grow, t.w + grow * 2, t.h + grow * 2)} {...props} />
          );
        // ROUND_PX quantises the SHAPE of a round table, not its styling: outline,
        // texture and bevel are the same weight the rects wear, so the two read as one
        // set of furniture rather than two. Only the staircase edge is coarse.
        const edge = 0.5;

        return (
          <g
            key={t.id}
            className="table"
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={selectedId === t.id}
            onClick={() => onSelect(selectedId === t.id ? null : t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(selectedId === t.id ? null : t.id);
              }
            }}
          >
            {/* A guest fills their chair. Occupancy as a filled block, not a hue shift,
                so the room visibly fills in greyscale and at video compression. */}
            {chairs(t).map(([cx, cy], i) => (
              <rect
                key={i}
                x={cx - CHAIR / 2}
                y={cy - CHAIR / 2}
                width={CHAIR}
                height={CHAIR}
                fill={i < seated ? 'var(--select)' : 'var(--chair)'}
                stroke="var(--chair-back)"
                strokeWidth="0.5"
              />
            ))}

            {footprint({ fill: 'url(#plank)' })}
            {/* Section identity tints the top, the way the mockup tints by status.
                An occupied table wears its section colour at full strength. */}
            {footprint({ fill: `var(${section?.color ?? '--panel'})`, opacity: party ? 0.72 : 0.28 })}
            {/* Outline LAST of the fills. A tint painted over the outline eats the half
                of the stroke that falls inside the shape, so the edge used to thin out
                in proportion to how opaque the tint was — which is why an occupied
                table's outline looked lighter than an empty one's. */}
            {footprint({ fill: 'none', stroke: 'var(--edge)', strokeWidth: edge })}

            {/* Bevel: every object in the mockup is lit from above. On a round table
                it is the rim one pixel in, lit above and shadowed below — the two
                halves of the same staircase, so it steps with the outline around it. */}
            {round ? (
              <>
                <polyline
                  points={pixelCircle(t.x, t.y, r - ROUND_PX).top}
                  fill="none"
                  stroke="var(--select)"
                  strokeWidth="0.5"
                  opacity="0.3"
                />
                <polyline
                  points={pixelCircle(t.x, t.y, r - ROUND_PX).bottom}
                  fill="none"
                  stroke="#1e120a"
                  strokeWidth="0.5"
                  opacity="0.34"
                />
              </>
            ) : (
              <>
                <rect x={x + 1} y={y + 1} width={t.w - 2} height="0.5" fill="var(--select)" opacity="0.3" />
                <rect x={x + 1} y={y + t.h - 1.5} width={t.w - 2} height="0.5" fill="#1e120a" opacity="0.34" />
              </>
            )}

            {/* Provenance is dash vs solid, never colour alone — survives greyscale
                and a compressed video frame (§6.1). */}
            {t.provenance === 'agent' &&
              footprint({ fill: 'none', stroke: 'var(--select)', strokeWidth: edge, strokeDasharray: '2 2' })}

            {/* A conflict is ringed OUTSIDE the tabletop, at the same offset as the
                selection halo — never across the top, where it would cut through the
                table's own name. Amber warns, alert is an error, matching the strip. */}
            {flag &&
              footprint(
                { fill: 'none', stroke: flag === 'error' ? 'var(--alert)' : 'var(--amber)', strokeWidth: edge },
                3,
              )}

            {/* Silkscreen advances ~0.6em, so a 3-char name is ~1.8x the font size in
                cells. On a ROUND table the width available is the chord at the label's
                own y, not the diameter — which is what used to push T12 over its edge. */}
            <PixelText x={t.x} y={t.y - 1.5} size={t.w >= 10 ? 3 : 2.5} fill="var(--select)" shadow="rgba(24,14,8,.65)">
              {t.name}
            </PixelText>
            <text x={t.x} y={t.y + 2} fontSize="2" fill="var(--select)" opacity="0.78">
              {party ? `${t.seats}·${section?.name.charAt(0) ?? ''}` : String(t.seats)}
            </text>

            {/* Pinned: a pushpin on the tabletop. Shape, not colour, so it survives
                greyscale and a compressed video frame — this is the 2:40 beat (§9). */}
            {(t.pinned || party?.pinned) &&
              (() => {
                // Top-left of the footprint box: on the tabletop for a rect, and on the
                // free NW diagonal for a round, where no chair ever sits.
                const [px, py] = round ? [x, y] : [x + 2, y + 2];
                return (
                  <g>
                    <rect x={px} y={py + 2.5} width="0.5" height="1.5" fill="#1e120a" />
                    <rect
                      x={px - 1}
                      y={py}
                      width="2.5"
                      height="2.5"
                      fill="var(--select)"
                      stroke="#1e120a"
                      strokeWidth="0.5"
                    />
                  </g>
                );
              })()}

            <rect
              className="halo"
              x={x - 3}
              y={y - 3}
              width={t.w + 6}
              height={t.h + 6}
              fill="none"
              stroke="var(--select)"
              strokeWidth="0.5"
              opacity="0.7"
            />
            {selectedId === t.id && (
              <rect
                x={x - 3}
                y={y - 3}
                width={t.w + 6}
                height={t.h + 6}
                fill="none"
                stroke="var(--select)"
                strokeWidth="0.5"
              />
            )}
          </g>
        );
      })}
      </g>
    </svg>
  );
}

// Read-only pixel-art floor plan (MISE_PLAN.md §6.1).
//
// Inline SVG, not canvas: every table is a real focusable node, so click handling,
// focus rings, keyboard nav and screen-reader labels come free and set_view can
// scrollIntoView it later (§6).
//
// The viewBox is measured in CELLS (1 cell = 0.125 m), so one cell is one pixel-art
// pixel. Every coordinate below must stay an integer.
import type { FloorPlan as Plan, Party, Table, Wall } from './types.ts';

/** Wall thickness, in cells. */
const WALL = 2;
/** Gap between a table edge and its seat dots, in cells. */
const SEAT_GAP = 3;
const SEAT_SIZE = 2;

const WALL_FILL: Record<Wall['kind'], string> = {
  wall: 'var(--ink)',
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

/** Top-left corners of each seat dot, in integer cells. */
function seatDots(t: Table): [number, number][] {
  const half = SEAT_SIZE / 2;
  if (t.shape === 'round') {
    const r = t.w / 2 + SEAT_GAP;
    return Array.from({ length: t.seats }, (_, i) => {
      const a = (i / t.seats) * Math.PI * 2 - Math.PI / 2;
      return [
        Math.round(t.x + Math.cos(a) * r - half),
        Math.round(t.y + Math.sin(a) * r - half),
      ] as [number, number];
    });
  }
  // Rect tables seat along the two long edges.
  const top = Math.ceil(t.seats / 2);
  const rows: [number, number][] = [];
  for (const [n, y] of [
    [top, t.y - t.h / 2 - SEAT_GAP - half],
    [t.seats - top, t.y + t.h / 2 + SEAT_GAP - half],
  ] as const) {
    for (let i = 0; i < n; i++) {
      rows.push([Math.round(t.x - t.w / 2 + ((i + 1) * t.w) / (n + 1) - half), Math.round(y)]);
    }
  }
  return rows;
}

interface Props {
  plan: Plan;
  parties: Party[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function FloorPlan({ plan, parties, selectedId, onSelect }: Props) {
  const { bounds } = plan;
  const sectionOf = new Map(
    plan.sections.flatMap((s) => s.tableIds.map((id) => [id, s] as const)),
  );
  const partyAt = new Map(parties.filter((p) => p.tableId).map((p) => [p.tableId!, p]));

  return (
    <svg
      className="floor"
      viewBox={`0 0 ${bounds.w} ${bounds.h}`}
      aria-label="Restaurant floor plan"
    >
      <defs>
        {/* The 0.5 m snap grid, one rect instead of ~900 dots. */}
        <pattern id="snap" width={plan.gridSize} height={plan.gridSize} patternUnits="userSpaceOnUse">
          <rect width="1" height="1" fill="var(--line)" />
        </pattern>
      </defs>

      <rect width={bounds.w} height={bounds.h} fill="var(--paper)" />
      <rect
        x={WALL}
        y={22}
        width={bounds.w - WALL * 2}
        height={bounds.h - 22 - WALL}
        fill="url(#snap)"
      />
      {/* Kitchen zone reads as a different floor. */}
      <rect x={WALL} y={WALL} width={bounds.w - WALL * 2} height={20 - WALL} fill="var(--panel)" />

      {plan.walls.map((w) => (
        <rect key={w.id} {...wallRect(w, bounds)} fill={WALL_FILL[w.kind]} />
      ))}

      {plan.stations.map((s) => (
        <g key={s.id}>
          <rect
            x={s.x - s.w / 2}
            y={s.y - s.h / 2}
            width={s.w}
            height={s.h}
            fill="var(--panel)"
            stroke="var(--ink)"
            strokeWidth="1"
          />
          <text x={s.x} y={s.y} fontSize="4">
            {s.name}
          </text>
        </g>
      ))}

      {plan.tables.map((t) => {
        const section = sectionOf.get(t.id);
        const party = partyAt.get(t.id);
        const fill = section ? `var(${section.color})` : 'var(--panel)';
        const label = [
          `Table ${t.name}`,
          `seats ${t.seats}`,
          section ? `${section.name} section` : 'no section',
          party ? `seated: ${party.name}, party of ${party.size}` : 'empty',
          t.pinned ? 'pinned' : null,
          `placed by ${t.provenance}`,
        ]
          .filter(Boolean)
          .join(', ');

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
            {seatDots(t).map(([x, y], i) => (
              <rect key={i} x={x} y={y} width={SEAT_SIZE} height={SEAT_SIZE} fill="var(--ink-mute)" />
            ))}
            {t.shape === 'round' ? (
              <circle
                className="tableShape"
                cx={t.x}
                cy={t.y}
                r={t.w / 2}
                fill={fill}
                stroke="var(--ink)"
                strokeWidth="1"
                // Provenance is dash vs solid, never colour alone — survives greyscale
                // and a compressed video frame (§6.1).
                strokeDasharray={t.provenance === 'agent' ? '2 2' : undefined}
              />
            ) : (
              <rect
                className="tableShape"
                x={t.x - t.w / 2}
                y={t.y - t.h / 2}
                width={t.w}
                height={t.h}
                fill={fill}
                stroke="var(--ink)"
                strokeWidth="1"
                strokeDasharray={t.provenance === 'agent' ? '2 2' : undefined}
              />
            )}
            {/* Silkscreen advances ~0.6em, so a 3-char name needs ~1.8x the font
                size in cells. Drop a size on the 2-tops rather than let it spill. */}
            <text x={t.x} y={t.y + 1} fontSize={t.w >= 8 ? 4 : 3}>
              {t.name}
            </text>
            {selectedId === t.id && (
              <rect
                x={t.x - t.w / 2 - 2}
                y={t.y - t.h / 2 - 2}
                width={t.w + 4}
                height={t.h + 4}
                fill="none"
                stroke="var(--alert)"
                strokeWidth="1"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

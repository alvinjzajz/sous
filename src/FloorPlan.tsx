// The pixel-art floor (MISE_PLAN.md §6.1), styled to match ../Mise.dc.html.
//
// Inline SVG, not absolutely-positioned divs like the mockup: every table is a real
// focusable node, so click handling, focus rings, keyboard nav and screen-reader
// labels come free and set_view can scrollIntoView it later (§6). The mockup's look
// — wood planks, chunky dark edges, bevelled tops, chair blocks — all reproduces with
// patterns and rects, so none of it costs us the accessibility.
//
// The viewBox is measured in CELLS (1 cell = 0.125 m), so one cell is one pixel-art
// pixel. Every coordinate below must stay an integer.
import type { FloorPlan as Plan, Party, Station, Table, Wall } from './types.ts';

/** Wall thickness, in cells. */
const WALL = 2;
/** Chair block size and its gap from the table edge, in cells. */
const CHAIR = 3;
/** Chairs sit flush to the aisle: at 8-10 cells between tables, any more overlaps. */
const CHAIR_GAP = 1;
/** Corner notch, in cells. The mockup's signature — square objects are never square. */
const NOTCH = 1;
/** Top of the dining floor: below the kitchen line and its wall. */
const FLOOR_TOP = 22;

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
      <text x={x} y={y + 1} fontSize={size} fill={shadow}>{children}</text>
      <text x={x} y={y} fontSize={size} fill={fill}>{children}</text>
    </>
  );
}

/** Cook stations read as back-of-house steel-green; the bar reads as wood. */
const stationFill = (s: Station) => (s.type === 'bar' ? 'url(#plank)' : 'var(--counter)');
const stationEdge = (s: Station) => (s.type === 'bar' ? 'var(--edge)' : 'var(--counter-dk)');

interface Props {
  plan: Plan;
  parties: Party[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function FloorPlan({ plan, parties, selectedId, onSelect }: Props) {
  const { bounds } = plan;
  const sectionOf = new Map(plan.sections.flatMap((s) => s.tableIds.map((id) => [id, s] as const)));
  const partyAt = new Map(parties.filter((p) => p.tableId).map((p) => [p.tableId!, p]));

  return (
    <svg className="floor" viewBox={`0 0 ${bounds.w} ${bounds.h}`} aria-label="Restaurant floor plan">
      <defs>
        {/* Floorboards: planks running the width of the room, seamed every 8 cells. */}
        <pattern id="floorboards" width={bounds.w} height="8" patternUnits="userSpaceOnUse">
          <rect width={bounds.w} height="8" fill="var(--wood)" />
          <rect y="7" width={bounds.w} height="1" fill="var(--wood-dk)" />
          <rect x="0" width="1" height="7" fill="var(--wood-dk)" opacity="0.5" />
          <rect x={Math.round(bounds.w / 3)} width="1" height="7" fill="var(--wood-dk)" opacity="0.5" />
          <rect x={Math.round((bounds.w * 2) / 3)} width="1" height="7" fill="var(--wood-dk)" opacity="0.5" />
        </pattern>
        {/* Tabletops get a tighter plank so they read as a separate object. */}
        <pattern id="plank" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="var(--wood)" />
          <rect y="3" width="4" height="1" fill="var(--wood-dk)" />
        </pattern>
        {/* Back of house is tiled, not boarded. */}
        <pattern id="tile" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="#9e8c72" />
          <rect width="4" height="4" fill="#8e7c63" />
          <rect x="4" y="4" width="4" height="4" fill="#8e7c63" />
        </pattern>
        {/* The 0.5 m snap grid, one rect instead of ~900 dots. */}
        <pattern id="snap" width={plan.gridSize} height={plan.gridSize} patternUnits="userSpaceOnUse">
          <rect width="1" height="1" fill="var(--select)" opacity="0.25" />
        </pattern>
      </defs>

      <rect width={bounds.w} height={bounds.h} fill="url(#tile)" />
      {['url(#floorboards)', 'url(#snap)'].map((fill) => (
        <rect
          key={fill}
          x={WALL}
          y={FLOOR_TOP}
          width={bounds.w - WALL * 2}
          height={bounds.h - FLOOR_TOP - WALL}
          fill={fill}
        />
      ))}

      {plan.walls.map((w) => (
        <rect key={w.id} {...wallRect(w, bounds)} fill={WALL_FILL[w.kind]} />
      ))}

      {plan.stations.map((s) => {
        const x = s.x - s.w / 2;
        const y = s.y - s.h / 2;
        return (
          <g key={s.id}>
            <polygon points={notched(x, y, s.w, s.h)} fill={stationFill(s)} stroke={stationEdge(s)} strokeWidth="1" />
            <rect x={x + 1} y={y + 1} width={s.w - 2} height="1" fill="var(--select)" opacity="0.18" />
            <rect x={x + 1} y={y + s.h - 2} width={s.w - 2} height="1" fill="#0c1a14" opacity="0.4" />
            <PixelText x={s.x} y={s.y} size={4} fill="var(--select)" shadow="rgba(12,26,20,.55)">
              {s.name.toUpperCase()}
            </PixelText>
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

        /** Same footprint, drawn repeatedly: top, section tint, provenance ring. */
        const footprint = (props: Record<string, string | number>) =>
          round ? (
            <circle cx={t.x} cy={t.y} r={r} {...props} />
          ) : (
            <polygon points={notched(x, y, t.w, t.h)} {...props} />
          );

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
            {chairs(t).map(([cx, cy], i) => (
              <rect
                key={i}
                x={cx - CHAIR / 2}
                y={cy - CHAIR / 2}
                width={CHAIR}
                height={CHAIR}
                fill="var(--wood)"
                stroke="var(--edge)"
                strokeWidth="1"
              />
            ))}

            {footprint({ fill: 'url(#plank)', stroke: 'var(--edge)', strokeWidth: 1 })}
            {/* Section identity tints the top, the way the mockup tints by status. */}
            {footprint({ fill: `var(${section?.color ?? '--panel'})`, opacity: 0.62 })}

            {/* Bevel: every object in the mockup is lit from above. */}
            {round ? (
              <>
                <path
                  d={`M ${t.x - r + 1} ${t.y} A ${r - 1} ${r - 1} 0 0 1 ${t.x + r - 1} ${t.y}`}
                  fill="none"
                  stroke="var(--select)"
                  strokeWidth="1"
                  opacity="0.3"
                />
                <path
                  d={`M ${t.x - r + 1} ${t.y} A ${r - 1} ${r - 1} 0 0 0 ${t.x + r - 1} ${t.y}`}
                  fill="none"
                  stroke="#1e120a"
                  strokeWidth="1"
                  opacity="0.34"
                />
              </>
            ) : (
              <>
                <rect x={x + 1} y={y + 1} width={t.w - 2} height="1" fill="var(--select)" opacity="0.3" />
                <rect x={x + 1} y={y + t.h - 2} width={t.w - 2} height="1" fill="#1e120a" opacity="0.34" />
              </>
            )}

            {/* Provenance is dash vs solid, never colour alone — survives greyscale
                and a compressed video frame (§6.1). */}
            {t.provenance === 'agent' &&
              footprint({ fill: 'none', stroke: 'var(--select)', strokeWidth: 1, strokeDasharray: '2 2' })}

            {/* Silkscreen advances ~0.6em, so a 3-char name needs ~1.8x the font size
                in cells. Drop a size on the 2-tops rather than let it spill. */}
            <PixelText x={t.x} y={t.y} size={t.w >= 8 ? 4 : 3} fill="var(--select)" shadow="rgba(24,14,8,.65)">
              {t.name}
            </PixelText>

            <rect
              className="halo"
              x={x - 3}
              y={y - 3}
              width={t.w + 6}
              height={t.h + 6}
              fill="none"
              stroke="var(--select)"
              strokeWidth="1"
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
                strokeWidth="1"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

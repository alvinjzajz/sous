// Mise domain model (MISE_PLAN.md §2).
//
// GEOMETRY UNITS: every x/y/w/h in this file is in CELLS, never metres or pixels.
// 1 cell = 0.125 m. The floor-plan SVG viewBox is measured in cells, so a cell is
// literally one pixel-art pixel (§6.1). All geometry must be integer cells.
export const CELL_M = 0.125;

/** ADA 2010 §403.5.1 accessible route minimum, 915 mm, expressed in cells. */
export const MIN_AISLE_CELLS = 915 / 1000 / CELL_M; // 7.32

export type Provenance = 'human' | 'agent';
export type StationType = 'grill' | 'saute' | 'fry' | 'cold' | 'pass' | 'bar';
/** Where a party is in their meal. */
export type CourseStage =
  | 'seated' | 'drinks' | 'apps' | 'mains' | 'dessert' | 'check' | 'departed';
/** The subset a menu item can belong to. */
export type MenuCourse = Extract<CourseStage, 'drinks' | 'apps' | 'mains' | 'dessert'>;

export interface Wall {
  id: string;
  x1: number; y1: number; x2: number; y2: number;
  kind: 'wall' | 'window' | 'door';
}

export interface Table {
  id: string;
  name: string;
  /** Centre point, in cells. */
  x: number; y: number;
  /** Full width/height, in cells. For round tables w === h (the diameter). */
  w: number; h: number;
  shape: 'round' | 'rect';
  seats: number;
  sectionId: string;
  pinned: boolean;
  provenance: Provenance;
}

export interface Station {
  id: string;
  type: StationType;
  /** Centre point, in cells. */
  x: number; y: number;
  w: number; h: number;
  name: string;
  /** How many items this station can cook at once. */
  concurrency: number;
}

export interface Section {
  id: string;
  name: string;
  serverName: string;
  /** CSS custom-property name from the §6.1 palette, e.g. '--sage'. */
  color: string;
  tableIds: string[];
}

export interface FloorPlan {
  bounds: { w: number; h: number };
  /** Snap grid for layout edits, in cells. 4 cells = 0.5 m (§4). */
  gridSize: number;
  walls: Wall[];
  tables: Table[];
  stations: Station[];
  sections: Section[];
}

export interface Party {
  id: string;
  name: string;
  size: number;
  tableId: string | null;
  /** Shift-minute stamp. Elapsed time is DERIVED against the clock, never stored (§2). */
  seatedAt: number;
  course: CourseStage;
  notes: string;
  allergies: string[];
  vip: boolean;
  pinned: boolean;
  provenance: Provenance;
}

export interface Reservation {
  id: string;
  name: string;
  size: number;
  /** Shift-minute the booking is for. */
  time: number;
  status: 'expected' | 'arrived' | 'seated' | 'no-show';
  notes: string;
}

export interface WaitEntry {
  id: string;
  name: string;
  size: number;
  /** Shift-minute the party joined the list. */
  addedAt: number;
  quotedMinutes: number;
}

export interface MenuItem {
  id: string;
  name: string;
  stationType: StationType;
  cookMinutes: number;
  course: MenuCourse;
  price: number;
  is86d: boolean;
}

export type TicketItemStatus = 'queued' | 'cooking' | 'plated' | 'served';

export interface TicketItem {
  menuItemId: string;
  qty: number;
  status: TicketItemStatus;
  /** Shift-minute cooking actually began. Null until a station slot frees (§8). */
  startedAt: number | null;
}

export interface Ticket {
  id: string;
  partyId: string;
  course: MenuCourse;
  items: TicketItem[];
  /** Shift-minute the ticket was fired. NOT when cooking starts. */
  firedAt: number;
  /** Shift-minute the ticket should be on the pass. */
  dueAt: number;
  provenance: Provenance;
}

export interface ServiceNote {
  id: string;
  from: 'server' | 'chef' | 'host';
  tableId?: string;
  /** User-typed. Untrusted: never interpolate into a tool schema (§12.1). */
  text: string;
  status: 'open' | 'resolved';
  response?: string;
  /** Shift-minute the note appears. */
  createdAt: number;
}

export interface Conflict {
  type: string;
  severity: 'warn' | 'error';
  targetId: string;
  message: string;
  suggestion?: string;
}

export interface Shift {
  /** Minutes since 5:00 PM. */
  clock: number;
  running: boolean;
  speed: number;
  seed: number;
  mode: 'design' | 'service';
}

export interface MiseState {
  plan: FloorPlan;
  parties: Party[];
  reservations: Reservation[];
  waitlist: WaitEntry[];
  menu: MenuItem[];
  tickets: Ticket[];
  notes: ServiceNote[];
  shift: Shift;
}

/** Shift-minutes since 5:00 PM -> "7:15 PM". */
export function fmtClock(minutes: number): string {
  const total = 17 * 60 + minutes;
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

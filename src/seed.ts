// Seed scenario (SOUS_PLAN.md §7): Saturday night at a neighbourhood bistro.
// 16 tables / 60 seats, 4 sections, 5 stations + bar, 22 menu items,
// 12 reservations totalling 38 covers, 2 service notes timed to surface mid-shift.
//
// The shift starts EMPTY at 5:00 PM. There is no hand-authored mid-service fixture —
// set_clock({to:"19:15"}) replays the reservation book to produce it (§7).
//
// All geometry is in cells (1 cell = 0.125 m). Room is 136 x 108 cells = 17 m x 13.5 m.
import type {
  FloorPlan, MenuItem, SousState, Reservation, Section, ServiceNote, Station, Table, Wall,
} from './types.ts';

export const SEED = 20260903;

const ROOM = { w: 136, h: 108 };
/** Kitchen occupies y < 20; the dining floor is everything below the pass line. */
const PASS_Y = 20;

const walls: Wall[] = [
  { id: 'w-n', x1: 0, y1: 0, x2: ROOM.w, y2: 0, kind: 'wall' },
  { id: 'w-e1', x1: ROOM.w, y1: 0, x2: ROOM.w, y2: 24, kind: 'wall' },
  { id: 'w-e2', x1: ROOM.w, y1: 24, x2: ROOM.w, y2: 100, kind: 'window' },
  { id: 'w-e3', x1: ROOM.w, y1: 100, x2: ROOM.w, y2: ROOM.h, kind: 'wall' },
  { id: 'w-s1', x1: ROOM.w, y1: ROOM.h, x2: 76, y2: ROOM.h, kind: 'wall' },
  { id: 'w-door', x1: 76, y1: ROOM.h, x2: 60, y2: ROOM.h, kind: 'door' },
  { id: 'w-s2', x1: 60, y1: ROOM.h, x2: 0, y2: ROOM.h, kind: 'wall' },
  { id: 'w-w1', x1: 0, y1: ROOM.h, x2: 0, y2: 100, kind: 'wall' },
  { id: 'w-w2', x1: 0, y1: 100, x2: 0, y2: 24, kind: 'window' },
  { id: 'w-w3', x1: 0, y1: 24, x2: 0, y2: 0, kind: 'wall' },
  // Kitchen line. The gap at x 96..112 is the pass; the counter at x >= 112 is the bar.
  { id: 'w-kitchen', x1: 0, y1: PASS_Y, x2: 96, y2: PASS_Y, kind: 'wall' },
  { id: 'w-bar-face', x1: 112, y1: PASS_Y, x2: ROOM.w, y2: PASS_Y, kind: 'wall' },
  { id: 'w-bar-side', x1: 112, y1: 0, x2: 112, y2: PASS_Y, kind: 'wall' },
];

const stations: Station[] = [
  { id: 'st-cold', type: 'cold', name: 'Cold', x: 20, y: 10, w: 24, h: 10, concurrency: 5 },
  { id: 'st-fry', type: 'fry', name: 'Fry', x: 48, y: 10, w: 20, h: 10, concurrency: 3 },
  { id: 'st-saute', type: 'saute', name: 'Saute', x: 72, y: 10, w: 20, h: 10, concurrency: 4 },
  { id: 'st-grill', type: 'grill', name: 'Grill', x: 96, y: 10, w: 20, h: 10, concurrency: 4 },
  { id: 'st-pass', type: 'pass', name: 'Pass', x: 104, y: 20, w: 16, h: 4, concurrency: 8 },
  { id: 'st-bar', type: 'bar', name: 'Bar', x: 124, y: 10, w: 20, h: 14, concurrency: 6 },
];

/** [id, cx, cy, w, h, shape, seats, sectionId] */
const TABLE_ROWS: [string, number, number, number, number, 'round' | 'rect', number, string][] = [
  ['T1', 16, 36, 8, 8, 'round', 2, 'sec-sage'],
  ['T2', 16, 54, 10, 10, 'round', 4, 'sec-sage'],
  ['T3', 16, 74, 10, 10, 'round', 4, 'sec-sage'],
  ['T4', 36, 74, 10, 10, 'round', 4, 'sec-sage'],
  ['T5', 56, 36, 8, 8, 'round', 2, 'sec-amber'],
  ['T6', 58, 54, 20, 10, 'rect', 6, 'sec-amber'],
  ['T7', 56, 74, 10, 10, 'round', 4, 'sec-amber'],
  ['T8', 78, 36, 10, 10, 'round', 4, 'sec-amber'],
  ['T9', 104, 36, 10, 10, 'round', 4, 'sec-rose'],
  ['T10', 104, 54, 20, 10, 'rect', 6, 'sec-rose'],
  ['T11', 104, 74, 10, 10, 'round', 4, 'sec-rose'],
  ['T12', 122, 74, 8, 8, 'round', 2, 'sec-rose'],
  ['T13', 36, 92, 8, 8, 'round', 2, 'sec-bar'],
  ['T14', 52, 92, 8, 8, 'round', 2, 'sec-bar'],
  ['T15', 68, 92, 8, 8, 'round', 2, 'sec-bar'],
  ['T16', 96, 92, 24, 10, 'rect', 8, 'sec-bar'],
];

const tables: Table[] = TABLE_ROWS.map(([id, x, y, w, h, shape, seats, sectionId]) => ({
  id, name: id, x, y, w, h, shape, seats, sectionId,
  pinned: false,
  provenance: 'human' as const,
}));

const sections: Section[] = [
  { id: 'sec-sage', name: 'Sage', serverName: 'Rosa', color: '--sage', tableIds: ['T1', 'T2', 'T3', 'T4'] },
  { id: 'sec-amber', name: 'Amber', serverName: 'Dmitri', color: '--amber', tableIds: ['T5', 'T6', 'T7', 'T8'] },
  { id: 'sec-rose', name: 'Rose', serverName: 'Priya', color: '--rose', tableIds: ['T9', 'T10', 'T11', 'T12'] },
  { id: 'sec-bar', name: 'Bar', serverName: 'Tomas', color: '--clay', tableIds: ['T13', 'T14', 'T15', 'T16'] },
];

export const floorPlan: FloorPlan = { bounds: ROOM, gridSize: 4, walls, tables, stations, sections };

/** [id, name, station, cookMinutes, course, price] */
const MENU_ROWS: [string, string, Station['type'], number, MenuItem['course'], number][] = [
  ['m-red', 'House Red', 'bar', 2, 'drinks', 12],
  ['m-negroni', 'Negroni', 'bar', 3, 'drinks', 14],
  ['m-lemonade', 'Sparkling Lemonade', 'bar', 2, 'drinks', 7],
  ['m-pilsner', 'Local Pilsner', 'bar', 2, 'drinks', 9],
  ['m-gem', 'Gem Lettuce Salad', 'cold', 4, 'apps', 13],
  ['m-burrata', 'Burrata and Peaches', 'cold', 5, 'apps', 16],
  ['m-oysters', 'Oysters, Half Dozen', 'cold', 6, 'apps', 21],
  ['m-artichoke', 'Crispy Artichokes', 'fry', 7, 'apps', 14],
  ['m-octopus', 'Charred Octopus', 'grill', 9, 'apps', 18],
  ['m-toast', 'Mushroom Toast', 'saute', 8, 'apps', 15],
  ['m-salmon', 'Grilled Salmon', 'grill', 14, 'mains', 32],
  ['m-halibut', 'Roast Halibut', 'saute', 15, 'mains', 34],
  ['m-ribeye', 'Dry-Aged Ribeye', 'grill', 18, 'mains', 58],
  ['m-chicken', 'Half Chicken', 'grill', 22, 'mains', 29],
  ['m-duck', 'Duck Breast', 'saute', 16, 'mains', 36],
  ['m-cacio', 'Cacio e Pepe', 'saute', 11, 'mains', 24],
  ['m-risotto', 'Mushroom Risotto', 'saute', 17, 'mains', 26],
  ['m-fishchips', 'Fish and Chips', 'fry', 12, 'mains', 27],
  ['m-oliveoil', 'Olive Oil Cake', 'cold', 4, 'dessert', 11],
  ['m-potdecreme', 'Chocolate Pot de Creme', 'cold', 3, 'dessert', 10],
  ['m-affogato', 'Affogato', 'bar', 3, 'dessert', 9],
  ['m-cheese', 'Cheese Plate', 'cold', 5, 'dessert', 17],
];

export const menu: MenuItem[] = MENU_ROWS.map(([id, name, stationType, cookMinutes, course, price]) => ({
  id, name, stationType, cookMinutes, course, price, is86d: false,
}));

/** Shift-minutes are counted from 5:00 PM, so 6:00 PM = 60. */
const at = (h: number, m: number) => (h - 17) * 60 + m;

/** [name, size, hour, minute, notes] — 12 bookings, 38 covers, 6:00-8:30 PM. */
const RES_ROWS: [string, number, number, number, string][] = [
  ['Achebe', 2, 18, 0, ''],
  ['Nakamura', 4, 18, 0, 'Birthday, candle on dessert'],
  ['Delacroix', 2, 18, 15, ''],
  ['Okonkwo', 6, 18, 30, 'Shellfish allergy at the table'],
  ['Whitfield', 2, 18, 30, ''],
  ['Ferreira', 2, 18, 45, ''],
  ['Lindqvist', 4, 19, 0, ''],
  ['Batiste', 2, 19, 0, 'Regular, prefers the bar'],
  ['Al-Rashid', 6, 19, 15, ''],
  ['Kowalczyk', 2, 19, 30, ''],
  ['Mensah', 2, 20, 0, ''],
  ['Sorrentino', 4, 20, 30, 'Anniversary'],
];

export const reservations: Reservation[] = RES_ROWS.map(([name, size, h, m, notes], i) => ({
  id: `r-${i + 1}`, name, size, time: at(h, m), status: 'expected' as const, notes,
}));

/** Surface mid-shift; both are demo beats (§9, 2:20 and 2:40). */
export const notes: ServiceNote[] = [
  {
    id: 'n-1', from: 'server', tableId: 'T7', status: 'open', createdAt: at(19, 10),
    text: 'T7 is catching a show at 8 - they need their mains by 7:40.',
  },
  {
    id: 'n-2', from: 'host', tableId: 'T12', status: 'open', createdAt: at(19, 20),
    text: 'T12 is an anniversary. Do not move them.',
  },
];

export function seedState(): SousState {
  return structuredClone({
    plan: floorPlan,
    overrides: [],
    parties: [],
    reservations,
    waitlist: [],
    menu,
    tickets: [],
    notes,
    shift: { clock: 0, running: false, speed: 1, seed: SEED, mode: 'design' as const },
  });
}

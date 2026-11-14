/**
 * Geometry for the living house (H01): an isometric-style cutaway ("dollhouse")
 * built from the household's chore rooms. Pure, so placement is unit tested and
 * the component only draws what this returns.
 *
 * Coordinates are SVG user units in a viewBox of `width × height`. Each room is a
 * rectangle on the front face (so its HTML link overlay is an exact rectangle that
 * never moves); depth comes from a receding side wall, a roof prism and each
 * room's inner walls and floor.
 */

export const HOUSE_GEOMETRY = {
  cellW: 120,
  cellH: 78,
  /** Receding depth of the side wall and roof. */
  depthX: 30,
  depthY: 18,
  roofH: 58,
  padX: 10,
  padTop: 4,
  groundH: 26,
  /** Inset of a room's back wall (one-point perspective). */
  inset: 9,
} as const;

/** Rooms shown in the house at most; the rest are summarized as "+N more". */
export const MAX_HOUSE_ROOMS = 6;

export type Point = { x: number; y: number };

export type RoomPlacement = {
  id: string;
  index: number;
  col: number;
  /** 0 is the top floor. */
  floor: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Front-face rectangle as percentages of the viewBox, for the link overlay. */
  box: { left: number; top: number; width: number; height: number };
  /** Zoom origin, percentages of the viewBox. */
  center: { x: number; y: number };
};

export type HouseLayout = {
  cols: number;
  floors: number;
  width: number;
  height: number;
  body: { x: number; y: number; w: number; h: number };
  /** Ground line (top of the yard). */
  groundY: number;
  rooms: RoomPlacement[];
  /** Grid cells with no room (drawn as plain wall with a window). */
  emptyCells: Array<{ x: number; y: number; w: number; h: number }>;
  roofFront: Point[];
  roofSide: Point[];
  sideWall: Point[];
  apex: Point;
  /** Height of the roof's front gable above the eaves (`HOUSE_GEOMETRY.roofH` by default). */
  roofH: number;
};

/** Columns for `n` rooms: one floor up to 3 rooms, 2×2 for four, else 3 wide. */
export function houseColumns(n: number): number {
  if (n <= 0) return 3;
  if (n <= 3) return n;
  if (n === 4) return 2;
  return 3;
}

const pct = (value: number, total: number) => Math.round((value / total) * 10_000) / 100;

/**
 * The tallest a room may grow when the house fills a tall pane (`fitHouse`): twice the
 * default, so a room stays a room (120 × 156 units) rather than a tall slot.
 */
export const MAX_CELL_H = HOUSE_GEOMETRY.cellH * 2;

/**
 * The tallest the roof may grow once the rooms are at `MAX_CELL_H`: twice the default
 * (a pitch of about 32 degrees on a three-room house instead of 17), never a spire.
 */
export const MAX_ROOF_H = HOUSE_GEOMETRY.roofH * 2;

/** Units of the scene's height that do not scale with the rooms: roof, eaves and yard. */
const FIXED_HEIGHT = HOUSE_GEOMETRY.padTop + HOUSE_GEOMETRY.roofH + HOUSE_GEOMETRY.depthY + HOUSE_GEOMETRY.groundH;

/** ViewBox width of a house `cols` rooms wide. */
const sceneWidth = (cols: number) => HOUSE_GEOMETRY.padX * 2 + cols * HOUSE_GEOMETRY.cellW + HOUSE_GEOMETRY.depthX + 6;

export type HouseFit = { cellH: number; roofH: number };

/**
 * Room and roof heights (SVG units) that let the house fill a pane of `box` CSS pixels
 * on the wide layout (wall tablet). The scene keeps its width (it scales to the pane's
 * width) and grows taller until its height meets the pane's: first the rooms, from the
 * default `cellH` to `MAX_CELL_H`, then, with the rooms at their tallest, the roof, from
 * the default `roofH` to `MAX_ROOF_H` (a steeper pitch, nothing stretched). A pane too
 * short for the default house keeps the defaults (the stage then shrinks to the pane's
 * height instead). Whole units, rounded down, so the scene never ends up taller than the
 * pane; whatever is still left over stays sky above the roof.
 */
export function fitHouse(roomCount: number, box: { width: number; height: number }): HouseFit {
  const g = HOUSE_GEOMETRY;
  const fit: HouseFit = { cellH: g.cellH, roofH: g.roofH };
  if (!(box.width > 0) || !(box.height > 0)) return fit;
  const cols = houseColumns(roomCount);
  const floors = Math.max(1, Math.ceil(roomCount / cols));
  const unitsTall = box.height * (sceneWidth(cols) / box.width);
  fit.cellH = Math.min(MAX_CELL_H, Math.max(g.cellH, Math.floor((unitsTall - FIXED_HEIGHT) / floors)));
  const spare = Math.floor(unitsTall - FIXED_HEIGHT - fit.cellH * floors);
  if (spare > 0) fit.roofH = Math.min(MAX_ROOF_H, g.roofH + spare);
  return fit;
}

const clampUnits = (value: number | undefined, min: number, max: number) =>
  Math.min(max, Math.max(min, value !== undefined && Number.isFinite(value) ? Math.round(value) : min));

/**
 * Lays the rooms out on the front face. `cellH` (default `HOUSE_GEOMETRY.cellH`, at most
 * `MAX_CELL_H`) makes every room taller and `roofH` (default `HOUSE_GEOMETRY.roofH`, at
 * most `MAX_ROOF_H`) the roof steeper: the wide layout passes `fitHouse` so the house
 * fills its pane; everything else (yard, windows, pets) keeps its size.
 */
export function layoutHouse(roomIds: readonly string[], options: Partial<HouseFit> = {}): HouseLayout {
  const g = HOUSE_GEOMETRY;
  const cellH = clampUnits(options.cellH, g.cellH, MAX_CELL_H);
  const roofH = clampUnits(options.roofH, g.roofH, MAX_ROOF_H);
  const n = roomIds.length;
  const cols = houseColumns(n);
  const floors = Math.max(1, Math.ceil(n / cols));
  const body = { x: g.padX, y: g.padTop + roofH + g.depthY, w: cols * g.cellW, h: floors * cellH };
  const width = sceneWidth(cols);
  const groundY = body.y + body.h;
  const height = groundY + g.groundH;

  const rooms: RoomPlacement[] = roomIds.map((id, index) => {
    const col = index % cols;
    const floor = Math.floor(index / cols);
    const x = body.x + col * g.cellW;
    const y = body.y + floor * cellH;
    return {
      id,
      index,
      col,
      floor,
      x,
      y,
      w: g.cellW,
      h: cellH,
      box: { left: pct(x, width), top: pct(y, height), width: pct(g.cellW, width), height: pct(cellH, height) },
      center: { x: pct(x + g.cellW / 2, width), y: pct(y + cellH / 2, height) },
    };
  });

  const emptyCells: HouseLayout['emptyCells'] = [];
  for (let index = n; index < cols * floors; index += 1) {
    emptyCells.push({ x: body.x + (index % cols) * g.cellW, y: body.y + Math.floor(index / cols) * cellH, w: g.cellW, h: cellH });
  }

  const right = body.x + body.w;
  const apex = { x: body.x + body.w / 2, y: body.y - roofH };
  const back = (p: Point): Point => ({ x: p.x + g.depthX, y: p.y - g.depthY });
  const eaveLeft = { x: body.x - 6, y: body.y };
  const eaveRight = { x: right + 6, y: body.y };

  return {
    cols,
    floors,
    width,
    height,
    body,
    groundY,
    rooms,
    emptyCells,
    roofFront: [eaveLeft, apex, eaveRight],
    roofSide: [apex, back(apex), back(eaveRight), eaveRight],
    sideWall: [{ x: right, y: body.y }, back({ x: right, y: body.y }), back({ x: right, y: groundY }), { x: right, y: groundY }],
    apex,
    roofH,
  };
}

/** A point on a room's floor, `t` from 0 (left) to 1 (right). */
export function floorPoint(room: Pick<RoomPlacement, 'x' | 'y' | 'w' | 'h'>, t: number): Point {
  const margin = 16;
  return { x: Math.round(room.x + margin + t * (room.w - margin * 2)), y: room.y + room.h - 6 };
}

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/** Room to focus for an arrow key (room by room), or null at an edge. */
export function roomNeighbor(layout: Pick<HouseLayout, 'rooms'>, id: string, key: NavKey): string | null {
  const { rooms } = layout;
  const current = rooms.find((room) => room.id === id);
  if (!current || rooms.length === 0) return null;
  switch (key) {
    case 'Home':
      return rooms[0].id;
    case 'End':
      return rooms[rooms.length - 1].id;
    case 'ArrowRight':
      return rooms[current.index + 1]?.id ?? null;
    case 'ArrowLeft':
      return rooms[current.index - 1]?.id ?? null;
    case 'ArrowUp':
    case 'ArrowDown': {
      const floor = current.floor + (key === 'ArrowDown' ? 1 : -1);
      const onFloor = rooms.filter((room) => room.floor === floor);
      if (onFloor.length === 0) return null;
      return (onFloor.find((room) => room.col === current.col) ?? onFloor[onFloor.length - 1]).id;
    }
    default:
      return null;
  }
}

export type PetMode = 'wander' | 'bowl' | 'idle';

/** A pet figure's radius, the spacing between hungry pets and between their rows (HP-11d). */
const PET_RADIUS = 9;
const PET_GAP = 16;
const BOWL_ROWS = 2;
const BOWL_ROW_GAP = 20;

export type PetPlacement = {
  id: string;
  mode: PetMode;
  /** Where the pet rests (the first waypoint when wandering). */
  at: Point;
  /** Wandering waypoints across rooms (three points; the CSS walks 0 → 1 → 2 and back). */
  path: Point[];
  /** The bowl a hungry pet sits by. */
  bowl: Point | null;
  /** Room the pet starts in, or null in the yard. */
  roomId: string | null;
};

/**
 * Where each pet is:
 * - fed today (`fed === true`): wanders between rooms on its floor;
 * - not fed on schedule (`false`): sits by its bowl, in the kitchen when there is
 *   one, else in the first ground-floor room;
 * - unknown (`null`, feeding history unavailable): rests in a room, no bowl, no
 *   wandering, so nothing is claimed either way.
 * Without rooms, pets stand in the yard.
 *
 * HP-11d: hungry pets line up left of the bowl inside the bowl's room, 16 units apart, in
 * up to two rows; more than fit are spaced closer, so none ever leaves the room. Without
 * a bowl room they keep their own yard spot, clamped to the scene.
 */
export function placePets(
  pets: ReadonlyArray<{ id: string; fed: boolean | null; needsMeal?: boolean }>,
  layout: HouseLayout,
  roomNames: Readonly<Record<string, string>> = {},
): PetPlacement[] {
  const { rooms } = layout;
  const yard = (i: number): Point => ({ x: Math.round(layout.body.x + 24 + i * 22), y: layout.groundY + Math.round(HOUSE_GEOMETRY.groundH / 2) });
  const bottomFloor = layout.floors - 1;
  const bowlRoom = rooms.find((room) => /kitchen/i.test(roomNames[room.id] ?? room.id))
    ?? rooms.find((room) => room.floor === bottomFloor)
    ?? null;
  const bowl: Point = bowlRoom ? floorPoint(bowlRoom, 0.86) : yard(0);
  // Only a confirmed meal slot that is due sends a pet to the bowl (D-P3, PE-31d).
  const hungryCount = pets.filter((pet) => pet.needsMeal).length;
  // The strip from the bowl to the room's left wall (inner inset plus the pet's radius).
  const from = bowl.x - 14;
  const to = bowlRoom ? bowlRoom.x + HOUSE_GEOMETRY.inset + PET_RADIUS : from;
  const span = Math.max(0, from - to);
  const perRow = Math.max(Math.floor(span / PET_GAP) + 1, Math.ceil(hungryCount / BOWL_ROWS));
  const gap = perRow > 1 ? Math.min(PET_GAP, span / (perRow - 1)) : 0;
  const bowlSpot = (k: number): Point => ({
    x: Math.round(from - (k % perRow) * gap),
    y: bowl.y - Math.floor(k / perRow) * BOWL_ROW_GAP,
  });
  let hungry = 0;

  return pets.map((pet, i) => {
    const home = rooms.length > 0 ? rooms[(i * 2) % rooms.length] : null;
    if (pet.needsMeal) {
      const yardAt = yard(i + 1);
      const at = bowlRoom ? bowlSpot(hungry) : { x: Math.min(yardAt.x, layout.width - PET_RADIUS), y: yardAt.y };
      hungry += 1;
      return { id: pet.id, mode: 'bowl', at, path: [at], bowl, roomId: bowlRoom?.id ?? null };
    }
    if (!home) {
      const at = yard(i + 1);
      return { id: pet.id, mode: 'idle', at, path: [at], bowl: null, roomId: null };
    }
    if (pet.fed === null) {
      const at = floorPoint(home, 0.3);
      return { id: pet.id, mode: 'idle', at, path: [at], bowl: null, roomId: home.id };
    }
    const sameFloor = rooms.filter((room) => room.floor === home.floor);
    const next = sameFloor.find((room) => room.col === home.col + 1) ?? sameFloor.find((room) => room.col === home.col - 1);
    const far = next ? sameFloor.find((room) => room.id !== home.id && room.id !== next.id) : undefined;
    const path = next
      ? [floorPoint(home, 0.3), floorPoint(next, 0.55), far ? floorPoint(far, 0.4) : floorPoint(home, 0.75)]
      : [floorPoint(home, 0.2), floorPoint(home, 0.8), floorPoint(home, 0.5)];
    return { id: pet.id, mode: 'wander', at: path[0], path, bowl: null, roomId: home.id };
  });
}

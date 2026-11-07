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
};

/** Columns for `n` rooms: one floor up to 3 rooms, 2×2 for four, else 3 wide. */
export function houseColumns(n: number): number {
  if (n <= 0) return 3;
  if (n <= 3) return n;
  if (n === 4) return 2;
  return 3;
}

const pct = (value: number, total: number) => Math.round((value / total) * 10_000) / 100;

export function layoutHouse(roomIds: readonly string[]): HouseLayout {
  const g = HOUSE_GEOMETRY;
  const n = roomIds.length;
  const cols = houseColumns(n);
  const floors = Math.max(1, Math.ceil(n / cols));
  const body = { x: g.padX, y: g.padTop + g.roofH + g.depthY, w: cols * g.cellW, h: floors * g.cellH };
  const width = g.padX * 2 + body.w + g.depthX + 6;
  const groundY = body.y + body.h;
  const height = groundY + g.groundH;

  const rooms: RoomPlacement[] = roomIds.map((id, index) => {
    const col = index % cols;
    const floor = Math.floor(index / cols);
    const x = body.x + col * g.cellW;
    const y = body.y + floor * g.cellH;
    return {
      id,
      index,
      col,
      floor,
      x,
      y,
      w: g.cellW,
      h: g.cellH,
      box: { left: pct(x, width), top: pct(y, height), width: pct(g.cellW, width), height: pct(g.cellH, height) },
      center: { x: pct(x + g.cellW / 2, width), y: pct(y + g.cellH / 2, height) },
    };
  });

  const emptyCells: HouseLayout['emptyCells'] = [];
  for (let index = n; index < cols * floors; index += 1) {
    emptyCells.push({ x: body.x + (index % cols) * g.cellW, y: body.y + Math.floor(index / cols) * g.cellH, w: g.cellW, h: g.cellH });
  }

  const right = body.x + body.w;
  const apex = { x: body.x + body.w / 2, y: body.y - g.roofH };
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
 */
export function placePets(
  pets: ReadonlyArray<{ id: string; fed: boolean | null }>,
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
  let hungry = 0;

  return pets.map((pet, i) => {
    const home = rooms.length > 0 ? rooms[(i * 2) % rooms.length] : null;
    if (pet.fed === false) {
      const at = { x: bowl.x - 14 - hungry * 16, y: bowl.y };
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

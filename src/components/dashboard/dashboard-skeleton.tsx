import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';
import { layoutHouse } from '@/lib/dashboard/house-layout';

/*
 * The house outline is drawn in the server HTML (H01: the house shows in under 1 s on a
 * mid-range phone). Before Firebase Auth restores the session there is no household to
 * draw, so this is the same geometry as the living house for a typical four-room home,
 * static and data-free; the live house (room states, pets, lights) replaces it once the
 * dashboard loads. Pure SVG from a dependency-free layout module: no Firebase, no
 * animation, so it is safe in the signed-out first paint (H03).
 */
const OUTLINE = layoutHouse(['a', 'b', 'c', 'd']);
const points = (list: Array<{ x: number; y: number }>) => list.map((p) => `${p.x},${p.y}`).join(' ');

function HouseOutline() {
  const { body, width, height, groundY, rooms, emptyCells, sideWall, roofSide, roofFront, apex } = OUTLINE;
  return (
    <div data-testid="living-house-placeholder" className="mb-6 overflow-hidden rounded-2xl border bg-card/80 shadow-raised">
      <div className="px-4 pt-3">
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="px-3 pt-1 sm:px-6">
        <div className="relative mx-auto w-full max-w-2xl" style={{ aspectRatio: `${width} / ${height}` }}>
          <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full overflow-visible">
            <rect x="0" y={groundY} width={width} height={height - groundY} className="fill-secondary/70" />
            <line x1="0" x2={width} y1={groundY} y2={groundY} className="stroke-border" strokeWidth="1.5" />
            <polygon points={points(sideWall)} className="fill-muted stroke-border" strokeWidth="1.5" strokeLinejoin="round" />
            <polygon points={points(roofSide)} className="fill-muted stroke-border" strokeWidth="1.5" strokeLinejoin="round" />
            <polygon points={points(roofFront)} className="fill-secondary stroke-border" strokeWidth="2" strokeLinejoin="round" />
            <circle cx={apex.x} cy={body.y - 22} r="10" className="fill-background stroke-border" strokeWidth="2" />
            <rect x={body.x} y={body.y} width={body.w} height={body.h} className="fill-background/40 stroke-border" strokeWidth="2" />
            {[...rooms, ...emptyCells].map((cell) => (
              <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width={cell.w} height={cell.h} className="fill-card stroke-border" strokeWidth="1" />
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}

/** Dashboard loading layout: header, the house outline, brief line, then the tile grid. */
export function DashboardSkeleton() {
  return (
    <RouteSkeleton label="your dashboard" className="py-6 md:py-8">
      <div className="mb-4 space-y-2">
        <Skeleton className="h-9 w-60" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <HouseOutline />
      <Skeleton className="mb-6 h-7 w-3/4 max-w-xl" />
      <Skeleton className="mb-3 h-7 w-44" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="min-h-[8.5rem] rounded-xl sm:col-span-2 lg:row-span-2" />
        <Skeleton className="min-h-[8.5rem] rounded-xl sm:col-span-2" />
        <Skeleton className="hidden min-h-[8.5rem] rounded-xl sm:block" />
        <Skeleton className="hidden min-h-[8.5rem] rounded-xl sm:block" />
      </div>
    </RouteSkeleton>
  );
}

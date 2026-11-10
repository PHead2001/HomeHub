import type { CSSProperties } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { RouteSkeleton } from '@/components/route-skeletons';
import { layoutHouse } from '@/lib/dashboard/house-layout';
import { DEFAULT_SKELETON_TILES, type TileDescriptor } from '@/lib/dashboard/tiles';
import { cn } from '@/lib/utils';
import { TileGridSkeleton } from './tile-grid-skeleton';
import styles from './dashboard.module.css';

/*
 * The house outline is drawn in the server HTML (H01: the house shows in under 1 s on a
 * mid-range phone). Before Firebase Auth restores the session there is no household to
 * draw, so this is the same geometry as the living house for a typical four-room home,
 * static and data-free; the live house (room states, pets, lights) replaces it once the
 * dashboard loads. Pure SVG from a dependency-free layout module: no Firebase, no
 * animation, so it is safe in the signed-out first paint (H03).
 *
 * The page layout is the dashboard's own (HP-12: two panes on wide landscape screens)
 * and the tile grid comes from the same descriptor list as the real grid (HP-26b).
 */
const OUTLINE = layoutHouse(['a', 'b', 'c', 'd']);
const points = (list: Array<{ x: number; y: number }>) => list.map((p) => `${p.x},${p.y}`).join(' ');

function HouseOutline() {
  const { body, width, height, groundY, rooms, emptyCells, sideWall, roofSide, roofFront, apex } = OUTLINE;
  return (
    <div data-testid="living-house-placeholder" className={cn(styles.houseSection, 'mb-6 overflow-hidden rounded-2xl border bg-card/80 shadow-raised')}>
      <div className="px-4 pt-3">
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="px-3 pt-1 sm:px-6">
        <div className={cn(styles.stageFrame, 'relative')} style={{ aspectRatio: `${width} / ${height}`, '--house-aspect': width / height } as CSSProperties}>
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
      {/* The yard row under the house (fridge, outdoor unit, pets). */}
      <div className="mt-2 border-t border-border-subtle bg-secondary/40 px-4 pb-2 pt-3">
        <Skeleton className="h-[3.25rem] w-40" />
      </div>
    </div>
  );
}

/**
 * Dashboard loading layout: subtitle, the house outline, brief line, then the tile grid.
 * `tiles` is the member's descriptor list once their permissions are known; before Auth
 * restores the session it is a full member's list.
 */
export function DashboardSkeleton({ tiles = DEFAULT_SKELETON_TILES }: { tiles?: readonly TileDescriptor[] }) {
  return (
    <RouteSkeleton label="your dashboard" className="py-0">
      <div className={styles.page}>
        <div className="min-w-0">
          <div className={cn(styles.lead, 'mb-4 space-y-2')}>
            <Skeleton className={cn(styles.wideHidden, 'h-9 w-60')} />
            <Skeleton className="h-5 w-72 max-w-full" />
          </div>
          <HouseOutline />
        </div>
        <div className="min-w-0">
          <div className={styles.briefSlot}>
            <Skeleton className="mb-6 h-7 w-3/4 max-w-xl" />
          </div>
          <div className={cn(styles.tilesSection, 'mb-8')}>
            <Skeleton className={cn(styles.wideHidden, 'mb-3 h-7 w-44')} />
            <TileGridSkeleton tiles={tiles} />
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}

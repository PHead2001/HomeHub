import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { tileSpanStyle, type TileDescriptor } from '@/lib/dashboard/tiles';
import styles from './dashboard.module.css';

/**
 * A grid cell for one tile descriptor (HP-26): its span at each breakpoint and its
 * phone compactness. Shared by the real grid and the skeleton so both lay out alike.
 * Dependency-free (no Firebase, no hooks): it is part of the server HTML skeleton.
 */
export function TileCell({ tile, children }: { tile: TileDescriptor; children: ReactNode }) {
  return (
    <div
      className={cn(styles.tileCell, tile.compactOnPhone && styles.tileCompact)}
      style={tileSpanStyle(tile) as CSSProperties}
      data-tile={tile.id}
    >
      {children}
    </div>
  );
}

export function TileSkeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn(styles.tileSkeleton, 'animate-pulse rounded-xl border bg-muted/40', className)} />;
}

/** The loading grid: one placeholder per descriptor, same count, order and spans. */
export function TileGridSkeleton({ tiles }: { tiles: readonly TileDescriptor[] }) {
  return (
    <div className={styles.tileGrid} data-testid="dashboard-grid-skeleton">
      {tiles.map((tile) => (
        <TileCell key={tile.id} tile={tile}>
          <TileSkeleton />
        </TileCell>
      ))}
    </div>
  );
}

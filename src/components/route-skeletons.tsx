import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/*
 * Route loading skeletons (H12/D08). Each `src/app/** /loading.tsx` composes these
 * to match its page's layout (same container, header and first content block), so
 * the real page replaces the skeleton without shifting. Skeletons are static under
 * reduced motion (the pulse is a CSS animation covered by the global rule).
 */

/** Page container with an accessible loading status. */
export function RouteSkeleton({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn('container mx-auto px-4 py-8', className)}>
      <span className="sr-only">Loading {label}…</span>
      <div aria-hidden className="contents">
        {children}
      </div>
    </div>
  );
}

/** Matches the `h1.text-3xl` + muted description block used by every page header. */
export function PageHeaderSkeleton({
  action = false,
  centered = false,
  titleWidth = 'w-56',
  className,
}: {
  action?: boolean;
  centered?: boolean;
  titleWidth?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-8 flex flex-col gap-3',
        centered ? 'items-center text-center' : 'sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className={cn('space-y-2', centered && 'flex flex-col items-center')}>
        <Skeleton className={cn('h-9', titleWidth)} />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      {action && <Skeleton className="h-10 w-full sm:w-36" />}
    </div>
  );
}

/** A `TabsList` placeholder. */
export function TabsSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn('h-10 w-full rounded-md', className)} />;
}

export function CardSkeleton({ className, lines = 2 }: { className?: string; lines?: number }) {
  return (
    <div className={cn('rounded-lg border bg-card p-6 shadow-raised', className)}>
      <Skeleton className="mb-4 h-6 w-1/2" />
      <div className="space-y-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
        ))}
      </div>
    </div>
  );
}

export function ListRowsSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}

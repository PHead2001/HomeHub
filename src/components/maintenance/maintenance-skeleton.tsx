import { CardSkeleton, PageHeaderSkeleton, TabsSkeleton } from '@/components/route-skeletons';

/**
 * The Maintenance Center's one loading skeleton (MA-25a): the header with Add Log, the tab row
 * (one row at every width, like the real one) and the Overview's Needs doing list beside the
 * health and Coming up cards. The route's `loading.tsx` and the page's first load both
 * render it, so a cold load keeps the header and tabs in place instead of swapping layouts.
 */
export function MaintenanceSkeleton() {
  return (
    <div className="space-y-6" data-testid="maintenance-skeleton">
      <div data-testid="maintenance-skeleton-header">
        <PageHeaderSkeleton action titleWidth="w-72" className="mb-0" />
      </div>
      <div data-testid="maintenance-skeleton-tabs">
        <TabsSkeleton className="h-[calc(var(--target-min)+0.5rem)]" />
      </div>
      <div className="grid gap-4 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]" data-testid="maintenance-skeleton-panel">
        <CardSkeleton lines={4} className="h-96" />
        <div className="space-y-4">
          <CardSkeleton lines={2} className="h-44" />
          <CardSkeleton lines={2} className="h-48" />
        </div>
      </div>
    </div>
  );
}

/** The page's first load (inside the page's own container): the same skeleton with a loading status. */
export function MaintenanceLoadingState() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading maintenance…</span>
      <div aria-hidden className="contents">
        <MaintenanceSkeleton />
      </div>
    </div>
  );
}

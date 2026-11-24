import { CardSkeleton, PageHeaderSkeleton, TabsSkeleton } from '@/components/route-skeletons';

/**
 * The Maintenance Center's one loading skeleton (MA-25a): the header with Add Log, the tab row
 * and the Overview's summary cards. The route's `loading.tsx` and the page's first load both
 * render it, so a cold load keeps the header and tabs in place instead of swapping layouts.
 */
export function MaintenanceSkeleton() {
  return (
    <div className="space-y-6" data-testid="maintenance-skeleton">
      <div data-testid="maintenance-skeleton-header">
        <PageHeaderSkeleton action titleWidth="w-72" className="mb-0" />
      </div>
      <div data-testid="maintenance-skeleton-tabs">
        <TabsSkeleton className="h-[5.25rem] md:h-10" />
      </div>
      <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="maintenance-skeleton-panel">
        {Array.from({ length: 5 }, (_, i) => (
          <CardSkeleton key={i} lines={1} className="h-32" />
        ))}
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

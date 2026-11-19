'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * "Load more" under a paginated pet history (PE-21h). While the next page loads
 * the entries already shown stay and the button keeps its place and size (no
 * layout shift); it disappears once the history has no more entries.
 */
export function LoadMoreHistory({ hasMore, loadingMore, onLoadMore, what }: { hasMore?: boolean; loadingMore?: boolean; onLoadMore: () => void; what: string }) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center pt-1">
      <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore} aria-label={`Load more ${what}`}>
        {loadingMore ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : null}
        {loadingMore ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  );
}

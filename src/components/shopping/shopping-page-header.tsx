'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ScanBarcode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { parseShoppingUrlState } from '@/lib/shopping/url-state';
import { cn } from '@/lib/utils';

type HeaderProps = {
  /** The member may see shopping: an open list then hides this header (SH-12a). */
  canView: boolean;
  /** The member record is still loading (the skeleton keeps the button's place). */
  pending: boolean;
};

function Header({ canView, pending, listOpen }: HeaderProps & { listOpen: boolean }) {
  // Inside an open list only the page's h1 stays, for screen readers; the list's
  // own compact header takes the space (S8b).
  const compact = listOpen && canView;
  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between', compact ? 'mb-0' : 'mb-8')} data-testid="shopping-page-header" data-compact={compact ? 'true' : 'false'}>
      {compact ? (
        // Only `sr-only`: a width utility beside it (`w-full`) would win over its 1 px
        // width and stretch the hidden box past the viewport (sideways page scroll).
        <h1 className="sr-only">Shopping Center</h1>
      ) : (
        <div className="w-full min-w-0">
          <h1 className="w-full font-headline text-3xl font-bold tracking-tight">Shopping Center</h1>
          <p className="text-muted-foreground">Lists in the order you walk the store, and a pantry that shows what is on the shelves.</p>
        </div>
      )}
      {pending && <Skeleton className="h-10 w-full shrink-0 sm:w-36" aria-hidden />}
      {canView && !compact && (
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href="/library">
            <ScanBarcode className="mr-2" aria-hidden /> Barcode Library
          </Link>
        </Button>
      )}
    </div>
  );
}

function HeaderFromUrl(props: HeaderProps) {
  const listOpen = Boolean(parseShoppingUrlState(useSearchParams()).listId);
  return <Header {...props} listOpen={listOpen} />;
}

/**
 * The Shopping Center's page header: the title, its intro and the Barcode
 * Library link. While a list is open (`?list=`) it collapses to a visually hidden
 * h1 (SH-12a); the Barcode Library is then in the list's actions menu.
 */
export function ShoppingPageHeader(props: HeaderProps) {
  return (
    <Suspense fallback={<Header {...props} listOpen={false} />}>
      <HeaderFromUrl {...props} />
    </Suspense>
  );
}

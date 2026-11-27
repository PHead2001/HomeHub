import type { Metadata } from 'next';
import { SECTION_TITLES } from '@/lib/shell/page-titles';
import { EmptyState } from '@/components/empty-state';

export const metadata: Metadata = {
  // SL-13: the root template adds " - HomeHub".
  title: SECTION_TITLES.notFound,
  robots: { index: false },
};

// Root 404 for every unknown path, including bot probes such as /.env or
// /.aws/config: Next answers with status 404 and this page, never a 500.
// Server-rendered, with no data access, so it paints at once signed in or out.
export default function NotFound() {
  return (
    <div className="container mx-auto flex max-w-md flex-col items-center px-4 py-16">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        data-testid="not-found"
        title="We couldn't find that page"
        description="The link may be old or mistyped. Everything in your home is still a tap away."
        action={{ href: '/', label: 'Go home' }}
      />
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Offline - HomeHub',
  robots: { index: false },
};

// Precached by the service worker (src/app/api/sw/route.ts) and served for any
// navigation that fails offline when no cached copy of that route exists.
export default function OfflinePage() {
  return (
    <div className="container mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <Logo size={56} />
      <h1 className="mt-6 font-headline text-3xl font-bold tracking-tight">You&apos;re offline</h1>
      <p className="mt-3 text-muted-foreground">
        This page needs a connection. Your shopping lists still open offline, and anything you tick
        off syncs when you&apos;re back online.
      </p>
      <div className="mt-8 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
        <Button asChild>
          <Link href="/shopping" prefetch={false}>Open shopping lists</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/" prefetch={false}>Go home</Link>
        </Button>
      </div>
    </div>
  );
}

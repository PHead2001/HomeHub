'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useSessionKnown } from '@/hooks/use-session-known';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { KitchenScanStation } from '@/components/barcode/kitchen-scan-station';
import Loading from '../loading';

/** The kitchen scan station (BL-20, BL-21): scan, scan, scan with one action selected. */
export default function ScanStationPage() {
  const { currentUser } = useAuth();
  const sessionKnown = useSessionKnown();
  if (!currentUser && !sessionKnown) return <Loading />;
  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight">Kitchen scan station</h1>
          <p className="text-muted-foreground">Keep the camera on and scan: used up, restocked or onto the list.</p>
        </div>
        <Link href="/library" className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline [@media(pointer:coarse)]:min-h-12">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Barcode Library
        </Link>
      </div>
      {!currentUser && <SignInPrompt what="use the scan station" />}
      {currentUser && <KitchenScanStation />}
    </div>
  );
}

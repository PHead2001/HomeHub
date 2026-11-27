import { Suspense } from 'react';
import { JoinLinkClient } from '@/components/household/join-link-client';

// Opening an invite link (audit HO-16, HO-23): /join?code=ABCD-EFGH-JK. The code is kept
// for the Join form and removed from the address bar; nothing is redeemed here.
export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinLinkClient />
    </Suspense>
  );
}

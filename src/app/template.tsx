import type { ReactNode } from 'react';
import { PageTransition } from '@/components/motion/page-transition';

// Templates remount on every navigation (layouts do not), so only page content
// crossfades; the header and phone tab bar in the root layout stay put.
export default function Template({ children }: { children: ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}

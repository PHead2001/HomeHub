import type { ReactNode } from 'react';
import { sectionMetadata } from '@/lib/shell/page-titles';

// SL-13: the page title; the page itself is a client component, which cannot export metadata.
export const metadata = sectionMetadata('calendar');

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}

'use client';

import { motion } from 'motion/react';
import { SPRING_SNAPPY } from '@/lib/motion';

export const HEADER_UNDERLINE_CLASS = 'absolute inset-x-2.5 bottom-0 coarse:inset-x-3 h-0.5 rounded-full bg-primary';

/** Active-link underline that slides between links (shared layoutId); instant under reduced motion. */
export function HeaderNavUnderline() {
  return <motion.span layoutId="header-nav-underline" aria-hidden className={HEADER_UNDERLINE_CLASS} transition={SPRING_SNAPPY} />;
}

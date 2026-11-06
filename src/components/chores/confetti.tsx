'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

// Token classes only, so every preset recolors the confetti.
const COLORS = ['bg-primary', 'bg-success', 'bg-warning', 'bg-info', 'bg-member-1', 'bg-member-3', 'bg-member-5', 'bg-member-7'];

type Particle = { id: number; dx: number; dy: number; rotate: number; color: string; round: boolean; size: number };
type Burst = { id: number; x: number; y: number; particles: Particle[] };

const LIFETIME_MS = 1100;

/**
 * Confetti from a point (H05). `burst(rect, count)` throws `count` pieces from the
 * center of `rect`. Decorative only: fixed, `aria-hidden`, no pointer events,
 * transform/opacity only, gone within 1.1 s and cleared by any input. Does nothing
 * under reduced motion.
 */
export function useConfetti() {
  const reduced = useReducedMotion();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const nextId = useRef(0);

  const burst = useCallback((rect: DOMRect | null | undefined, count: number) => {
    if (reduced || !rect || typeof window === 'undefined') return;
    const id = nextId.current++;
    const particles: Particle[] = Array.from({ length: count }, (_, i) => {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const distance = 40 + Math.random() * (40 + count * 2);
      return {
        id: i,
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance - 30,
        rotate: Math.random() * 360,
        color: COLORS[i % COLORS.length],
        round: i % 3 === 0,
        size: 5 + Math.round(Math.random() * 4),
      };
    });
    setBursts(previous => [...previous, { id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, particles }]);
    window.setTimeout(() => setBursts(previous => previous.filter(b => b.id !== id)), LIFETIME_MS);
  }, [reduced]);

  useEffect(() => {
    if (bursts.length === 0) return;
    const clear = () => setBursts([]);
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('keydown', clear, true);
    window.addEventListener('wheel', clear, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', clear, true);
      window.removeEventListener('keydown', clear, true);
      window.removeEventListener('wheel', clear, true);
    };
  }, [bursts.length]);

  const layer = bursts.length > 0 && typeof document !== 'undefined'
    ? createPortal(
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[95] overflow-hidden">
        {bursts.map(b => b.particles.map(p => (
          <motion.span
            key={`${b.id}-${p.id}`}
            className={`absolute ${p.color} ${p.round ? 'rounded-full' : 'rounded-[2px]'}`}
            style={{ left: b.x, top: b.y, width: p.size, height: p.size }}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
            animate={{ x: p.dx, y: [0, p.dy, p.dy + 60], opacity: [1, 1, 0], rotate: p.rotate, scale: 0.8 }}
            transition={{ duration: LIFETIME_MS / 1000, ease: 'easeOut', times: [0, 0.55, 1] }}
          />
        )))}
      </div>,
      document.body,
    )
    : null;

  return { burst, layer };
}

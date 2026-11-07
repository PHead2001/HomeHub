'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cartFlightPath, type CartFlightPath } from '@/lib/shopping/cart-flight';

type Flight = { key: number; label: string; path: CartFlightPath };

/** Flight time (s): a UI transition, inside the 250–450 ms range of a drop. */
const FLIGHT_S = 0.42;
/** A flight that never reports completion (tab hidden, etc.) still lands. */
const SAFETY_MS = 900;

function FlightCopy({ flight, onLand }: { flight: Flight; onLand: (key: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onLand(flight.key), SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [flight.key, onLand]);

  const { start, dx, dy } = flight.path;
  return (
    <motion.span
      aria-hidden
      data-testid="cart-flight"
      className="pointer-events-none fixed z-[80] max-w-[12rem] truncate rounded-full border border-primary/40 bg-popover px-2.5 py-1 text-sm font-medium text-foreground shadow-overlay"
      style={{ left: start.x, top: start.y, transformOrigin: 'center' }}
      initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
      // A short lift, then the drop into the cart: transform and opacity only.
      animate={{ x: [0, dx * 0.35, dx], y: [0, Math.min(-12, dy * 0.15), dy], scale: [1, 0.9, 0.25], opacity: [1, 1, 0] }}
      transition={{ duration: FLIGHT_S, ease: [0.4, 0, 0.6, 1], times: [0, 0.35, 1] }}
      onAnimationComplete={() => onLand(flight.key)}
    >
      {flight.label}
    </motion.span>
  );
}

/**
 * "Into the cart" (H07): a ticked item's name flies from its row into the cart
 * icon as a separate, non-interactive copy (the row itself and its checkbox never
 * move), then the cart wobbles and counts up. `inFlight` lets the cart hold its
 * visible count until the copy lands; its accessible name always has the real
 * count. Skipped entirely under reduced motion or when either end is off screen.
 */
export function useCartFlight() {
  const reduced = useReducedMotion();
  const cartRef = useRef<HTMLButtonElement>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const nextKey = useRef(1);

  const land = useCallback((key: number) => {
    setFlights((current) => (current.some((flight) => flight.key === key) ? current.filter((flight) => flight.key !== key) : current));
  }, []);

  const launch = useCallback((source: Element | null, label: string) => {
    if (reduced || !source || !cartRef.current) return;
    const path = cartFlightPath(source.getBoundingClientRect(), cartRef.current.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (!path) return;
    const key = nextKey.current++;
    setFlights((current) => [...current, { key, label, path }]);
  }, [reduced]);

  const layer = typeof document === 'undefined' || flights.length === 0 ? null : createPortal(
    <>
      {flights.map((flight) => <FlightCopy key={flight.key} flight={flight} onLand={land} />)}
    </>,
    document.body,
  );

  return { cartRef, launch, inFlight: flights.length, layer };
}

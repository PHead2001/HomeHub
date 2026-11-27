"use client";

import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs` (NO-11): relative ages ("2 minutes
 * ago") keep ticking and Today / This week roll over on an always-on screen.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

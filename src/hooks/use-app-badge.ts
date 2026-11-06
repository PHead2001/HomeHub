"use client";

import { useEffect } from "react";

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Mirrors `count` onto the installed app's home-screen/taskbar icon with the
 * Badging API. A zero count, or unmounting (sign-out), clears the badge; `null`
 * (count not known yet) leaves the current badge alone.
 * No-op where the API is unsupported; failures (e.g. permission not granted on
 * iOS) are ignored because the badge is decorative.
 */
export function useAppBadge(count: number | null) {
  useEffect(() => {
    if (count === null || typeof navigator === "undefined") return;
    const badging = navigator as BadgingNavigator;
    if (typeof badging.setAppBadge !== "function" || typeof badging.clearAppBadge !== "function") return;

    const update = count > 0 ? badging.setAppBadge(count) : badging.clearAppBadge();
    update.catch(() => undefined);
  }, [count]);

  useEffect(() => () => {
    if (typeof navigator === "undefined") return;
    const badging = navigator as BadgingNavigator;
    badging.clearAppBadge?.().catch(() => undefined);
  }, []);
}

'use client';

/**
 * After a palette result opens its page, the matching row is scrolled into view and
 * outlined for a moment (QA-12). Rows opt in with `data-row-id` (Shopping's item
 * rows). Runs outside React, since the palette closes as it navigates; it gives up
 * quietly after a few seconds.
 */
const HIGHLIGHT_MS = 2500;
const GIVE_UP_MS = 6000;
let pending: number | null = null;

export function highlightRowWhenShown(rowId: string): void {
  if (typeof window === 'undefined' || !rowId) return;
  if (pending !== null) window.clearInterval(pending);
  const started = Date.now();
  pending = window.setInterval(() => {
    const row = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`);
    if (!row && Date.now() - started < GIVE_UP_MS) return;
    if (pending !== null) window.clearInterval(pending);
    pending = null;
    if (!row) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    row.setAttribute('data-search-hit', '');
    window.setTimeout(() => row.removeAttribute('data-search-hit'), HIGHLIGHT_MS);
  }, 150);
}

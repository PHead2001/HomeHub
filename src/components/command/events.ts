/**
 * Window events that open the global command palette and the shortcut help from
 * anywhere (header search button, tab bar quick-add, dashboard hint) without
 * threading state through the layout. Quick-add entry points pass a `mode`
 * (Feeding, Item, Chore; QA-15), never pre-typed text.
 */
import type { PaletteMode } from '@/lib/dashboard/palette-mode';

export const PALETTE_EVENT = 'homehub:command-palette';
export const SHORTCUT_HELP_EVENT = 'homehub:shortcut-help';

export type PaletteRequest = { mode?: PaletteMode; voice?: boolean };

export function openCommandPalette(request: PaletteRequest = {}) {
  window.dispatchEvent(new CustomEvent<PaletteRequest>(PALETTE_EVENT, { detail: request }));
}

export function openShortcutHelp() {
  window.dispatchEvent(new Event(SHORTCUT_HELP_EVENT));
}

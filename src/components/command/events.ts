/**
 * Window events that open the global command palette and the shortcut help from
 * anywhere (header search button, tab bar quick-add, dashboard hint) without
 * threading state through the layout.
 */
export const PALETTE_EVENT = 'homehub:command-palette';
export const SHORTCUT_HELP_EVENT = 'homehub:shortcut-help';

export type PaletteRequest = { text?: string; voice?: boolean };

export function openCommandPalette(request: PaletteRequest = {}) {
  window.dispatchEvent(new CustomEvent<PaletteRequest>(PALETTE_EVENT, { detail: request }));
}

export function openShortcutHelp() {
  window.dispatchEvent(new Event(SHORTCUT_HELP_EVENT));
}

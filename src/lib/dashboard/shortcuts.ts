/**
 * Global keyboard shortcuts (H28). Pure matching so the sequences are tested; the
 * `ShortcutsProvider` wires them to the palette, quick-add and navigation.
 */
import type { HouseholdPermission } from '@/lib/types';
import type { PaletteMode } from './palette-mode';

export type ShortcutAction =
  | { type: 'palette' }
  | { type: 'help' }
  /** Opens the palette in a mode (Feeding, Item, Chore), never with typed text (QA-15). */
  | { type: 'quick-add'; mode: PaletteMode }
  | { type: 'go'; href: string };

/** Stable names for the bindings, used by `ShortcutHint` so hints never drift. */
export type ShortcutId =
  | 'palette'
  | 'palette-slash'
  | 'new-chore'
  | 'add-item'
  | 'log-feeding'
  | 'help'
  | `go-${'home' | 'chores' | 'shopping' | 'pets' | 'maintenance' | 'calendar' | 'notifications'}`;

export type ShortcutDefinition = {
  id: ShortcutId;
  keys: string[];
  label: string;
  action: ShortcutAction;
  permission?: HouseholdPermission;
};

/** Navigation targets reachable with `G` then a letter. */
export const GO_TARGETS: Record<string, { id: ShortcutId; href: string; label: string; permission?: HouseholdPermission }> = {
  h: { id: 'go-home', href: '/', label: 'Home' },
  c: { id: 'go-chores', href: '/chores', label: 'Chores', permission: 'chores.view' },
  s: { id: 'go-shopping', href: '/shopping', label: 'Shopping', permission: 'shopping.view' },
  p: { id: 'go-pets', href: '/pets', label: 'Pets', permission: 'pets.view' },
  m: { id: 'go-maintenance', href: '/maintenance', label: 'Maintenance', permission: 'maintenance.view' },
  k: { id: 'go-calendar', href: '/calendar', label: 'Calendar', permission: 'chores.view' },
  n: { id: 'go-notifications', href: '/notifications', label: 'Notifications', permission: 'notifications.view' },
};

export const SHORTCUTS: ShortcutDefinition[] = [
  { id: 'palette', keys: ['Ctrl', 'K'], label: 'Search or quick-add', action: { type: 'palette' } },
  { id: 'palette-slash', keys: ['/'], label: 'Search or quick-add', action: { type: 'palette' } },
  { id: 'new-chore', keys: ['N'], label: 'New chore', action: { type: 'quick-add', mode: 'chore' }, permission: 'chores.create' },
  { id: 'add-item', keys: ['A'], label: 'Add a shopping item', action: { type: 'quick-add', mode: 'item' }, permission: 'shopping.edit' },
  { id: 'log-feeding', keys: ['F'], label: 'Log a feeding', action: { type: 'quick-add', mode: 'feeding' }, permission: 'pets.addLogs' },
  ...Object.entries(GO_TARGETS).map(([letter, target]): ShortcutDefinition => ({
    id: target.id,
    keys: ['G', letter.toUpperCase()],
    label: `Go to ${target.label}`,
    action: { type: 'go', href: target.href } as ShortcutAction,
    permission: target.permission,
  })),
  { id: 'help', keys: ['?'], label: 'Show keyboard shortcuts', action: { type: 'help' } },
];

/** The binding for `id` (every id has exactly one). */
export function shortcutById(id: ShortcutId): ShortcutDefinition {
  const found = SHORTCUTS.find((shortcut) => shortcut.id === id);
  if (!found) throw new Error(`Unknown shortcut ${id}`);
  return found;
}

/** True for two-key sequences ("G then C"), false for chords ("Ctrl+K") and single keys. */
export function isShortcutSequence(shortcut: Pick<ShortcutDefinition, 'keys'>): boolean {
  return shortcut.keys.length > 1 && shortcut.keys[0] !== 'Ctrl';
}

/** Spoken/written form: "Ctrl+K", "N", "G then C". */
export function shortcutText(id: ShortcutId): string {
  const { keys } = shortcutById(id);
  return isShortcutSequence({ keys }) ? keys.join(' then ') : keys.join('+');
}

/**
 * The `aria-keyshortcuts` value, or undefined for sequences (the attribute cannot
 * express "G then C"; the visible hint still names them). Ctrl+K also accepts Cmd.
 */
export function ariaKeyShortcuts(id: ShortcutId): string | undefined {
  const { keys } = shortcutById(id);
  if (isShortcutSequence({ keys })) return undefined;
  if (keys[0] === 'Ctrl') return `Control+${keys[1]} Meta+${keys[1]}`;
  return keys[0];
}

export type KeyInput = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };

/**
 * True while an input method editor (IME: Japanese, Chinese, Korean, some mobile
 * keyboards) is composing text. Enter, arrows and Escape then belong to the IME
 * (confirm a candidate, move between candidates, cancel), so no handler may act on
 * them. Browsers report `isComposing`, and some send `keyCode` 229 instead.
 */
export function isComposingKey(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  const native = event.nativeEvent ?? event;
  return Boolean(event.isComposing || native.isComposing || event.keyCode === 229 || native.keyCode === 229);
}

/** True when focus is in a place where letters are typing, not commands. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).closest !== 'function') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return Boolean(element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="textbox"]'));
}

/**
 * Resolves one key press. `pendingGo` is true right after a bare `G`. Returns the
 * action (if any) and whether the next key completes a `G` sequence.
 * `allowed` filters by permission so hidden modules have no shortcut.
 */
export function matchShortcut(
  input: KeyInput,
  pendingGo: boolean,
  allowed: (permission?: HouseholdPermission) => boolean,
): { action: ShortcutAction | null; pendingGo: boolean } {
  if ((input.ctrlKey || input.metaKey) && !input.altKey && input.key.toLowerCase() === 'k') {
    return { action: { type: 'palette' }, pendingGo: false };
  }
  if (input.ctrlKey || input.metaKey || input.altKey) return { action: null, pendingGo: false };

  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (pendingGo) {
    const target = GO_TARGETS[key];
    if (target && allowed(target.permission)) return { action: { type: 'go', href: target.href }, pendingGo: false };
    return { action: null, pendingGo: false };
  }
  if (input.key === '?') return { action: { type: 'help' }, pendingGo: false };
  if (input.key === '/') return { action: { type: 'palette' }, pendingGo: false };
  if (key === 'g' && !input.shiftKey) return { action: null, pendingGo: true };
  if (input.shiftKey) return { action: null, pendingGo: false };
  const single = SHORTCUTS.find((shortcut) => shortcut.keys.length === 1 && shortcut.keys[0].toLowerCase() === key && shortcut.action.type === 'quick-add');
  if (single && allowed(single.permission)) return { action: single.action, pendingGo: false };
  return { action: null, pendingGo: false };
}

/** Konami code for the living house's disco mode (H29). */
export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/** Feeds one key into a Konami matcher; returns the new progress and whether it completed. */
export function konamiStep(progress: number, key: string): { progress: number; done: boolean } {
  const expected = KONAMI[progress];
  const normalized = key.length === 1 ? key.toLowerCase() : key;
  if (normalized === expected) {
    const next = progress + 1;
    return next === KONAMI.length ? { progress: 0, done: true } : { progress: next, done: false };
  }
  return { progress: normalized === KONAMI[0] ? 1 : 0, done: false };
}

/**
 * Key hints for the global quick-add shortcuts (H28), read from the shared
 * shortcut map so a hint never disagrees with the key that works. Used as the
 * `title` of the module buttons the shortcuts mirror (Add Chore → N, Feed → F).
 */
import { SHORTCUTS } from '../dashboard/shortcuts';

/** "New chore from anywhere: press N", or undefined if no shortcut uses the prefix. */
export function shortcutHint(prefix: string): string | undefined {
  const shortcut = SHORTCUTS.find((entry) => entry.action.type === 'quick-add' && entry.action.prefix === prefix);
  return shortcut ? `${shortcut.label} from anywhere: press ${shortcut.keys.join(' then ')}` : undefined;
}

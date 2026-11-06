/**
 * Pure helpers behind `MemberAvatar` / `MemberAvatarStack`
 * (src/components/member-avatar.tsx). Kept React-free so they are unit-tested.
 */

import { MEMBER_COLOR_COUNT } from './theme/tokens';
import type { MemberColorIndex } from './member-colors';

/**
 * One or two initials from a display name or email. "Sam Lee" → "SL",
 * "sam" → "S", "sam.lee@example.com" → "SL", "Mary-Kate Olsen" → "MO",
 * "" → "?". Uses the first letter/digit of the first and last word.
 */
export function memberInitials(name: string | null | undefined): string {
  let source = (name ?? '').trim();
  if (source.includes('@') && !source.includes(' ')) source = source.split('@')[0];
  const words = source
    .split(/[\s._]+/)
    .map((word) => Array.from(word).find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((ch): ch is string => Boolean(ch));
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return letters.join('').toLocaleUpperCase();
}

/**
 * The second color of a member's gradient: the slot three steps around the hue
 * wheel, so every gradient is a distinct, harmonious pair. Both ends are member
 * tokens, which are AA with `--member-foreground` in every preset, so initials
 * stay readable across the whole gradient.
 */
export function avatarGradientPartner(index: MemberColorIndex): MemberColorIndex {
  return ((((index - 1) + 3) % MEMBER_COLOR_COUNT) + 1) as MemberColorIndex;
}

/** CSS background for a generated avatar (token-based, no color literals). */
export function avatarGradient(index: MemberColorIndex): string {
  const partner = avatarGradientPartner(index);
  return `linear-gradient(135deg, hsl(var(--member-${index})) 0%, hsl(var(--member-${partner})) 100%)`;
}

/** How many avatars to draw and how many go into the "+k" chip. */
export function avatarStackSlots(count: number, max: number): { visible: number; overflow: number } {
  const total = Math.max(0, Math.floor(count));
  const limit = Math.max(1, Math.floor(max));
  if (total <= limit) return { visible: total, overflow: 0 };
  // The "+k" chip takes one slot so the stack never grows beyond `max` circles.
  const visible = limit - 1;
  return { visible, overflow: total - visible };
}

/** "Sam", "Sam and Alex", "Sam, Alex and Jo", "Sam, Alex and 3 others". */
export function formatMemberNames(names: readonly string[], maxNamed = 3): string {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (list.length === 0) return 'No members';
  if (list.length === 1) return list[0];
  if (list.length <= maxNamed) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const rest = list.length - (maxNamed - 1);
  return `${list.slice(0, maxNamed - 1).join(', ')} and ${rest} others`;
}

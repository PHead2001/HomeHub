/**
 * Per-member colors (H15). Every household member gets one of eight token colors
 * (`--member-1` … `--member-8`, defined per theme in src/lib/theme/tokens.ts and
 * AA-checked as text on every surface and as a chip fill with `--member-foreground`).
 *
 *   const c = memberColor(member.uid);
 *   <span className={cn('rounded-full px-2', c.classes.chip)}>Sam</span>
 *   <Avatar className={cn('ring-2', c.classes.ring)} />
 *   <div style={{ background: c.color }} />          // e.g. chart bars
 *
 * Use `memberColorMap(uids)` when several members appear together (calendar,
 * leaderboard): it keeps each member's own color where possible and resolves
 * collisions deterministically, so two members never share a color while the
 * household has ≤ 8 members.
 */

import { MEMBER_COLOR_COUNT } from './theme/tokens';

export type MemberColorIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type MemberColor = {
  index: MemberColorIndex;
  /** CSS custom property name, e.g. `--member-3`. */
  token: string;
  /** Solid color, e.g. for chart bars or SVG fills. Text-safe on every surface. */
  color: string;
  /** Text color on a solid member fill. */
  foreground: string;
  /** 15% tint for soft chip backgrounds; the solid color stays AA as text on it. */
  soft: string;
  /** Static Tailwind classes (listed literally so Tailwind generates them). */
  classes: { text: string; bg: string; border: string; ring: string; chip: string; softChip: string };
};

const CLASSES: Record<MemberColorIndex, MemberColor['classes']> = {
  1: { text: 'text-member-1', bg: 'bg-member-1', border: 'border-member-1', ring: 'ring-member-1', chip: 'bg-member-1 text-member-foreground', softChip: 'bg-member-1/15 text-member-1' },
  2: { text: 'text-member-2', bg: 'bg-member-2', border: 'border-member-2', ring: 'ring-member-2', chip: 'bg-member-2 text-member-foreground', softChip: 'bg-member-2/15 text-member-2' },
  3: { text: 'text-member-3', bg: 'bg-member-3', border: 'border-member-3', ring: 'ring-member-3', chip: 'bg-member-3 text-member-foreground', softChip: 'bg-member-3/15 text-member-3' },
  4: { text: 'text-member-4', bg: 'bg-member-4', border: 'border-member-4', ring: 'ring-member-4', chip: 'bg-member-4 text-member-foreground', softChip: 'bg-member-4/15 text-member-4' },
  5: { text: 'text-member-5', bg: 'bg-member-5', border: 'border-member-5', ring: 'ring-member-5', chip: 'bg-member-5 text-member-foreground', softChip: 'bg-member-5/15 text-member-5' },
  6: { text: 'text-member-6', bg: 'bg-member-6', border: 'border-member-6', ring: 'ring-member-6', chip: 'bg-member-6 text-member-foreground', softChip: 'bg-member-6/15 text-member-6' },
  7: { text: 'text-member-7', bg: 'bg-member-7', border: 'border-member-7', ring: 'ring-member-7', chip: 'bg-member-7 text-member-foreground', softChip: 'bg-member-7/15 text-member-7' },
  8: { text: 'text-member-8', bg: 'bg-member-8', border: 'border-member-8', ring: 'ring-member-8', chip: 'bg-member-8 text-member-foreground', softChip: 'bg-member-8/15 text-member-8' },
};

/** FNV-1a 32-bit hash: stable across sessions, devices and builds. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The member's own color slot (1–8) for a stable id (prefer the auth uid). */
export function memberColorIndex(id: string): MemberColorIndex {
  return ((hash(id) % MEMBER_COLOR_COUNT) + 1) as MemberColorIndex;
}

export function memberColorFromIndex(index: MemberColorIndex): MemberColor {
  return {
    index,
    token: `--member-${index}`,
    color: `hsl(var(--member-${index}))`,
    foreground: 'hsl(var(--member-foreground))',
    soft: `hsl(var(--member-${index}) / 0.15)`,
    classes: CLASSES[index],
  };
}

/** Deterministic color for one member. */
export function memberColor(id: string): MemberColor {
  return memberColorFromIndex(memberColorIndex(id));
}

/**
 * Collision-free colors for a group of members. Members are placed in id order;
 * each takes its own slot if free, otherwise the next free slot. Beyond eight
 * members colors repeat.
 */
export function memberColorMap(ids: readonly string[]): Map<string, MemberColor> {
  const result = new Map<string, MemberColor>();
  const taken = new Set<number>();
  for (const id of [...new Set(ids)].sort()) {
    let index = memberColorIndex(id);
    if (taken.size < MEMBER_COLOR_COUNT) {
      while (taken.has(index)) index = ((index % MEMBER_COLOR_COUNT) + 1) as MemberColorIndex;
    }
    taken.add(index);
    result.set(id, memberColorFromIndex(index));
  }
  return result;
}

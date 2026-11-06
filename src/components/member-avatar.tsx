'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '@/lib/utils';
import { memberColor, memberColorMap, type MemberColor } from '@/lib/member-colors';
import { avatarGradient, avatarStackSlots, formatMemberNames, memberInitials } from '@/lib/member-avatar';

export type MemberAvatarSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<MemberAvatarSize, string> = {
  sm: 'h-6 w-6 text-[0.625rem]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-14 w-14 text-lg',
};

const RING_CLASSES: Record<MemberAvatarSize, string> = {
  sm: 'ring-2 ring-offset-1',
  md: 'ring-2 ring-offset-2',
  lg: 'ring-[3px] ring-offset-2',
};

export type MemberAvatarMember = {
  /** Stable id (prefer the auth uid); picks the member color. */
  uid: string;
  /** Display name; used for initials and the accessible name. */
  name: string;
  /** Profile photo. When missing or it fails to load, the gradient avatar shows. */
  photoUrl?: string | null;
};

export type MemberAvatarProps = MemberAvatarMember & {
  size?: MemberAvatarSize;
  /** Draw a ring in the member's color (avatar ring from H15). */
  ring?: boolean;
  /** Color override, e.g. from `memberColorMap()` so a group never shares colors. */
  color?: MemberColor;
  /**
   * Hide from assistive tech when the member's name is already printed next to
   * the avatar. Otherwise the avatar is announced as the member's name.
   */
  decorative?: boolean;
  className?: string;
};

/**
 * A member's photo, or a generated gradient avatar (two member-color tokens,
 * diagonal) with initials. Never shows a broken image: Radix renders the photo
 * only after it has loaded and keeps the gradient on error.
 *
 *   <MemberAvatar uid={m.uid} name={m.name} photoUrl={m.avatarUrl} ring />
 */
export const MemberAvatar = React.forwardRef<HTMLSpanElement, MemberAvatarProps>(function MemberAvatar(
  { uid, name, photoUrl, size = 'md', ring = false, color, decorative = false, className },
  ref,
) {
  const c = color ?? memberColor(uid);
  const label = name.trim() || 'Member';
  return (
    <AvatarPrimitive.Root
      ref={ref}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      title={decorative ? undefined : label}
      className={cn(
        'relative inline-flex shrink-0 select-none overflow-hidden rounded-full align-middle',
        SIZE_CLASSES[size],
        ring && cn(RING_CLASSES[size], 'ring-offset-background', c.classes.ring),
        className,
      )}
    >
      {photoUrl ? (
        <AvatarPrimitive.Image src={photoUrl} alt="" aria-hidden className="h-full w-full object-cover" />
      ) : null}
      <AvatarPrimitive.Fallback
        aria-hidden
        className="flex h-full w-full items-center justify-center rounded-full font-semibold leading-none text-member-foreground"
        style={{ backgroundImage: avatarGradient(c.index) }}
      >
        {memberInitials(label)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
});

export type MemberAvatarStackProps = {
  members: readonly MemberAvatarMember[];
  /** Maximum circles drawn, including the "+k" chip. Default 4. */
  max?: number;
  size?: MemberAvatarSize;
  ring?: boolean;
  /** Accessible name for the group; defaults to the member names ("Sam, Alex and 2 others"). */
  label?: string;
  className?: string;
};

const OVERLAP: Record<MemberAvatarSize, string> = { sm: '-ml-1.5', md: '-ml-2.5', lg: '-ml-4' };

/**
 * Overlapping avatars for a group (assignees, who fed the dog this week). Colors
 * come from `memberColorMap`, so members in one stack never share a color. The
 * stack is one image to assistive tech, named after the members.
 */
export function MemberAvatarStack({ members, max = 4, size = 'md', ring = false, label, className }: MemberAvatarStackProps) {
  const colors = React.useMemo(() => memberColorMap(members.map((m) => m.uid)), [members]);
  const { visible, overflow } = avatarStackSlots(members.length, max);
  const names = members.map((m) => m.name);
  const groupLabel = label ?? formatMemberNames(names);
  return (
    <div role="img" aria-label={groupLabel} title={groupLabel} className={cn('flex items-center', className)}>
      {members.slice(0, visible).map((m, i) => (
        <MemberAvatar
          key={m.uid}
          {...m}
          size={size}
          ring={ring}
          color={colors.get(m.uid)}
          decorative
          // Without member rings, a background-colored ring separates the overlapping circles.
          className={cn(!ring && 'ring-2 ring-background', i > 0 && OVERLAP[size])}
        />
      ))}
      {overflow > 0 ? (
        <span
          aria-hidden
          className={cn(
            'relative inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold leading-none text-muted-foreground ring-2 ring-background',
            SIZE_CLASSES[size],
            visible > 0 && OVERLAP[size],
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

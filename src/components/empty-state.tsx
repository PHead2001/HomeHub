'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type EmptyStateKind = 'chores' | 'lists' | 'pets' | 'assets' | 'notifications' | 'generic';

export const EMPTY_STATE_KINDS: readonly EmptyStateKind[] = ['chores', 'lists', 'pets', 'assets', 'notifications', 'generic'];

/** A real `<button>` (onClick) or a real link (href). */
export type EmptyStateAction = { label: string; icon?: React.ReactNode } & (
  | { onClick: () => void; href?: never }
  | { href: string; onClick?: never }
);

export type EmptyStateProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> & {
  kind?: EmptyStateKind;
  title: string;
  /** One line: what this place is for, phrased as an invitation. */
  description: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Heading level for the title so it fits the page outline. Default 2. */
  headingLevel?: 2 | 3 | 4;
  /** Smaller illustration and spacing for cards and popovers. */
  compact?: boolean;
};

/* ------------------------------------------------------------------------- */
/* Illustrations                                                              */
/* ------------------------------------------------------------------------- */
// One style for every kind: a soft primary-tinted backdrop, a muted line drawing
// (stroke = currentColor from `text-muted-foreground`), one primary accent and a
// sparkle. Only token classes, so every preset (dark and light) recolors them.

const LINE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function Sparkle({ x, y, r = 4 }: { x: number; y: number; r?: number }) {
  return (
    <path
      className="fill-primary"
      d={`M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r}Z`}
    />
  );
}

function Backdrop() {
  return (
    <>
      <ellipse className="fill-primary/10" cx="60" cy="50" rx="46" ry="40" />
      <ellipse className="fill-muted" cx="60" cy="86" rx="30" ry="4" />
    </>
  );
}

const ART: Record<EmptyStateKind, React.ReactNode> = {
  chores: (
    <>
      <rect {...LINE} className="fill-card" x="38" y="20" width="44" height="60" rx="6" />
      <rect {...LINE} className="fill-card" x="50" y="15" width="20" height="9" rx="3" />
      <g className="text-primary">
        <path {...LINE} d="M46 38l4 4 7-8" />
        <path {...LINE} d="M46 54l4 4 7-8" />
      </g>
      <path {...LINE} d="M62 39h12M62 55h12M46 70h28" />
      <Sparkle x={92} y={24} />
      <Sparkle x={28} y={60} r={3} />
    </>
  ),
  lists: (
    <>
      <path {...LINE} className="fill-card" d="M36 38h48l-4 42H40z" />
      <path {...LINE} d="M48 38v-6a12 12 0 0 1 24 0v6" />
      <g className="text-primary">
        <path {...LINE} className="fill-primary/20" d="M52 58c0-8 8-12 16-12 0 8-6 14-16 12z" />
        <path {...LINE} d="M52 58l8-6" />
      </g>
      <path {...LINE} d="M46 70h28" />
      <Sparkle x={92} y={30} />
      <Sparkle x={26} y={52} r={3} />
    </>
  ),
  pets: (
    <>
      <path {...LINE} className="fill-card" d="M38 68h44l-5 12H43z" />
      <path {...LINE} d="M34 68h52" />
      <g className="text-primary">
        <ellipse {...LINE} className="fill-primary/20" cx="60" cy="48" rx="9" ry="8" />
        <circle {...LINE} className="fill-primary/20" cx="47" cy="36" r="4" />
        <circle {...LINE} className="fill-primary/20" cx="55" cy="28" r="4" />
        <circle {...LINE} className="fill-primary/20" cx="65" cy="28" r="4" />
        <circle {...LINE} className="fill-primary/20" cx="73" cy="36" r="4" />
      </g>
      <Sparkle x={92} y={26} />
      <Sparkle x={28} y={46} r={3} />
    </>
  ),
  assets: (
    <>
      <path {...LINE} className="fill-card" d="M36 46l24-20 24 20v34H36z" />
      <path {...LINE} d="M54 80V62h12v18" />
      <g className="text-primary">
        <circle {...LINE} className="fill-card" cx="82" cy="34" r="11" />
        <path {...LINE} d="M77 39l7-7M85 29a3 3 0 1 0 2 2" />
      </g>
      <Sparkle x={26} y={34} />
      <Sparkle x={96} y={60} r={3} />
    </>
  ),
  notifications: (
    <>
      <path {...LINE} className="fill-card" d="M42 66h36l-5-7V45a13 13 0 0 0-26 0v14z" />
      <path {...LINE} d="M55 72a5 5 0 0 0 10 0M60 26v6" />
      <g className="text-primary">
        <path {...LINE} d="M82 30h8l-8 9h8" />
        <path {...LINE} d="M92 18h5l-5 6h5" />
      </g>
      <Sparkle x={28} y={40} r={3} />
    </>
  ),
  generic: (
    <>
      <path {...LINE} className="fill-card" d="M34 56l8-22h36l8 22v22H34z" />
      <path {...LINE} d="M34 56h16a10 10 0 0 0 20 0h16" />
      <g className="text-primary">
        <path {...LINE} d="M60 18v10M48 22l4 6M72 22l-4 6" />
      </g>
      <Sparkle x={94} y={36} />
      <Sparkle x={26} y={42} r={3} />
    </>
  ),
};

export function EmptyStateIllustration({ kind = 'generic', className }: { kind?: EmptyStateKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 120 96"
      aria-hidden="true"
      focusable="false"
      className={cn('text-muted-foreground', className)}
      data-empty-illustration={kind}
    >
      <Backdrop />
      {ART[kind]}
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Component                                                                  */
/* ------------------------------------------------------------------------- */

function ActionControl({ action, variant }: { action: EmptyStateAction; variant: 'default' | 'ghost' }) {
  const content = (
    <>
      {action.icon}
      {action.label}
    </>
  );
  if (action.href !== undefined) {
    return (
      <Button asChild variant={variant}>
        <Link href={action.href}>{content}</Link>
      </Button>
    );
  }
  return (
    <Button type="button" variant={variant} onClick={action.onClick}>
      {content}
    </Button>
  );
}

/**
 * Illustrated empty state (H24): picture, title, one-line invitation and a
 * primary action. Fades in with a 6 px settle (200 ms CSS, opacity/transform only,
 * so nothing shifts or waits for hydration); under reduced motion it renders in place.
 *
 *   <EmptyState
 *     kind="chores"
 *     title="No chores yet"
 *     description="Add the first one and HomeHub will keep track of who does what."
 *     action={{ label: 'Add a chore', onClick: openCreate }}
 *   />
 */
export function EmptyState({
  kind = 'generic',
  title,
  description,
  action,
  secondaryAction,
  headingLevel = 2,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  return (
    <div
      {...props}
      data-empty-state={kind}
      className={cn('text-center', compact ? 'px-4 py-6' : 'px-6 py-10', className)}
    >
      {/* A CSS entrance runs from first paint, so server-rendered empty states never
          wait for hydration; the global reduced-motion rules collapse it to the end state. */}
      <div className={cn('flex flex-col items-center animate-in fade-in-0 slide-in-from-bottom-1.5 duration-200 ease-out', compact ? 'gap-2' : 'gap-3')}>
        <EmptyStateIllustration kind={kind} className={compact ? 'h-16 w-20' : 'h-24 w-[7.5rem]'} />
        <Heading className={cn('font-headline font-semibold text-foreground', compact ? 'text-base' : 'text-lg')}>{title}</Heading>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        {action || secondaryAction ? (
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            {action ? <ActionControl action={action} variant="default" /> : null}
            {secondaryAction ? <ActionControl action={secondaryAction} variant="ghost" /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

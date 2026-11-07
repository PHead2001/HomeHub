'use client';

/**
 * Peek links (H26) for any chore, item, pet or asset link in the app.
 *
 *   import { PeekLink, PeekFacts } from '@/components/ui/peek-link';
 *
 *   <PeekLink
 *     href={`/pets/${pet.id}`}
 *     peek={<PeekFacts title={pet.name} facts={[['Last fed', '8:10 am'], ['Next meal', '6 pm']]} />}
 *   >
 *     {pet.name}
 *   </PeekLink>
 *
 * Resting the mouse on the link (fine, hovering pointers only) or focusing it from
 * the keyboard for 400 ms shows a small spring-in card; touch never does. The card
 * is `aria-hidden` and never takes focus, so the link's own name must already carry
 * the important facts (the card only repeats or expands them). Escape, pointer down,
 * leaving, scrolling or resizing closes it. `peek={null}` renders a plain link.
 *
 * `PeekLink` takes every `next/link` prop (`onClick`, `data-*`, `aria-*`, `style`
 * for `morphStyle`), so it drops in for `<Link>`. `wrapperClassName` styles the
 * wrapper (`as`: `span` by default, so it works inline; `div` for block layouts,
 * `li` as a list row). For anything that is not a link, wrap it in `PeekCard`
 * (`@/components/dashboard/peek-card`) directly.
 */
import type { ComponentProps, ReactNode } from 'react';
import Link from 'next/link';
import { PeekCard } from '@/components/dashboard/peek-card';
import { cn } from '@/lib/utils';

export { PeekCard };

type PeekLinkProps = ComponentProps<typeof Link> & {
  /** Card content (see `PeekFacts`); null for no peek. */
  peek: ReactNode | null;
  as?: 'span' | 'div' | 'li';
  wrapperClassName?: string;
};

export function PeekLink({ peek, as = 'span', wrapperClassName, ...linkProps }: PeekLinkProps) {
  return (
    <PeekCard peek={peek} as={as} className={cn(as === 'span' && 'inline-block max-w-full', wrapperClassName)}>
      <Link {...linkProps} />
    </PeekCard>
  );
}

/** The standard peek body: an optional title and up to a few label/value rows. */
export function PeekFacts({ title, facts }: { title?: ReactNode; facts: Array<[ReactNode, ReactNode]> }) {
  return (
    <div className="space-y-1.5">
      {title ? <p className="truncate font-medium">{title}</p> : null}
      {facts.length > 0 && (
        <dl className="space-y-1">
          {facts.map(([label, value], index) => (
            <div key={index} className="flex justify-between gap-3">
              <dt className="truncate text-muted-foreground">{label}</dt>
              <dd className="shrink-0 text-right">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

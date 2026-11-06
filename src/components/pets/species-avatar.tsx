import * as React from 'react';
import { cn } from '@/lib/utils';
import { SPECIES_ART_LABEL, speciesArt, type SpeciesArt } from '@/lib/pets/care';
import styles from './pets.module.css';

/*
 * Illustrated species avatars for pets without a photo (D17, H09). One style for
 * every species, matching the EmptyState art: a primary-tinted backdrop, muted
 * shapes with a `currentColor` outline (from `text-muted-foreground`), foreground
 * eyes and one primary accent. Token classes only, so every preset recolors them.
 * Eyes blink with a CSS-only animation that stops under reduced motion.
 */

const LINE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const OUTLINE = { stroke: 'currentColor', strokeWidth: 2.5, strokeLinejoin: 'round' } as const;

function Eyes({ points, r = 3.5, ry, delay }: { points: [number, number][]; r?: number; ry?: number; delay?: 0 | 1 | 2 }) {
  return (
    <g className={styles.eyes} data-delay={delay}>
      {points.map(([cx, cy]) => (
        <ellipse key={`${cx}-${cy}`} className="fill-foreground" cx={cx} cy={cy} rx={r} ry={ry ?? r} />
      ))}
    </g>
  );
}

const ART: Record<SpeciesArt, (delay: 0 | 1 | 2) => React.ReactNode> = {
  dog: (delay) => (
    <>
      <path className="fill-muted-foreground/40" {...OUTLINE} d="M36 44 C22 46 20 72 30 82 C38 78 40 62 40 50 Z" />
      <path className="fill-muted-foreground/40" {...OUTLINE} d="M84 44 C98 46 100 72 90 82 C82 78 80 62 80 50 Z" />
      <ellipse className="fill-muted" {...OUTLINE} cx="60" cy="64" rx="26" ry="27" />
      <ellipse className="fill-card" {...OUTLINE} cx="60" cy="77" rx="13" ry="10" />
      <ellipse className="fill-foreground" cx="60" cy="72" rx="5" ry="3.5" />
      <path {...LINE} d="M60 75.5 v3.5 M54 81 q6 4 12 0" />
      <Eyes points={[[49, 58], [71, 58]]} delay={delay} />
      <path className="stroke-primary" fill="none" strokeWidth="5" strokeLinecap="round" d="M42 92 Q60 101 78 92" />
      <circle className="fill-primary" cx="60" cy="100" r="4" />
    </>
  ),
  cat: (delay) => (
    <>
      <path className="fill-muted" {...OUTLINE} d="M35 54 L39 26 L58 42 Z" />
      <path className="fill-muted" {...OUTLINE} d="M85 54 L81 26 L62 42 Z" />
      <ellipse className="fill-muted" {...OUTLINE} cx="60" cy="65" rx="30" ry="26" />
      <path className="fill-primary/30" d="M41 46 L43 34 L51 42 Z M79 46 L77 34 L69 42 Z" />
      <Eyes points={[[49, 62], [71, 62]]} r={3} ry={4.2} delay={delay} />
      <path className="fill-primary" d="M56.5 70 L63.5 70 L60 74.5 Z" />
      <path {...LINE} d="M60 74.5 q-4 5 -8 2 M60 74.5 q4 5 8 2" />
      <path {...LINE} strokeWidth={1.8} d="M42 71 L24 67 M42 76 L24 78 M78 71 L96 67 M78 76 L96 78" />
    </>
  ),
  bird: (delay) => (
    <>
      <path {...LINE} d="M57 38 q1 -9 8 -10 M61 39 q5 -6 11 -4" />
      <ellipse className="fill-muted" {...OUTLINE} cx="60" cy="66" rx="26" ry="28" />
      <ellipse className="fill-card" cx="60" cy="76" rx="15" ry="14" />
      <path className="fill-muted-foreground/40" {...OUTLINE} d="M36 62 Q30 82 48 90 Q46 74 36 62 Z" />
      <path className="fill-muted-foreground/40" {...OUTLINE} d="M84 62 Q90 82 72 90 Q74 74 84 62 Z" />
      <Eyes points={[[51, 56], [69, 56]]} delay={delay} />
      <path className="fill-primary" {...OUTLINE} strokeWidth={1.5} d="M55 62 L65 62 L60 70 Z" />
      <path {...LINE} d="M53 94 v7 M67 94 v7" />
    </>
  ),
  fish: (delay) => (
    <>
      <circle {...LINE} strokeWidth={2} cx="24" cy="36" r="3.5" />
      <circle {...LINE} strokeWidth={2} cx="17" cy="25" r="2.5" />
      <path className="fill-muted-foreground/40" {...OUTLINE} d="M84 62 L102 46 L102 78 Z" />
      <path className="fill-muted-foreground/40" {...OUTLINE} d="M48 44 Q58 30 70 44 Z" />
      <ellipse className="fill-muted" {...OUTLINE} cx="56" cy="62" rx="31" ry="21" />
      <path className="stroke-primary" fill="none" strokeWidth="4" strokeLinecap="round" d="M62 45 q-7 17 0 34" />
      <path {...LINE} d="M74 49 q-5 13 0 26" />
      <Eyes points={[[39, 58]]} r={4} delay={delay} />
      <path {...LINE} d="M27 67 q4 3 8 0" />
    </>
  ),
  'small-mammal': (delay) => (
    <>
      <circle className="fill-muted" {...OUTLINE} cx="39" cy="41" r="10" />
      <circle className="fill-muted" {...OUTLINE} cx="81" cy="41" r="10" />
      <circle className="fill-primary/30" cx="39" cy="41" r="5" />
      <circle className="fill-primary/30" cx="81" cy="41" r="5" />
      <ellipse className="fill-muted" {...OUTLINE} cx="60" cy="67" rx="32" ry="28" />
      <circle className="fill-primary/20" cx="41" cy="74" r="7" />
      <circle className="fill-primary/20" cx="79" cy="74" r="7" />
      <Eyes points={[[50, 61], [70, 61]]} delay={delay} />
      <ellipse className="fill-primary" cx="60" cy="69" rx="3.5" ry="2.5" />
      <path {...LINE} d="M60 71.5 v3 M55 76 q5 3 10 0" />
      <rect className="fill-card" {...OUTLINE} strokeWidth={1.5} x="57" y="77" width="6" height="5" rx="1" />
      <path {...LINE} strokeWidth={1.6} d="M47 71 L32 68 M73 71 L88 68" />
    </>
  ),
  reptile: (delay) => (
    <>
      <circle className="fill-muted" {...OUTLINE} cx="25" cy="64" r="11" />
      <path className="fill-muted" {...OUTLINE} d="M34 84 v8 a4 4 0 0 0 8 0 v-8 Z M78 84 v8 a4 4 0 0 0 8 0 v-8 Z" />
      <path className="fill-muted" {...OUTLINE} d="M96 78 l9 3 l-9 3 Z" />
      <path className="fill-muted-foreground/40" {...OUTLINE} d="M30 84 Q30 44 63 44 Q96 44 98 84 Z" />
      <path {...LINE} strokeWidth={2} d="M50 84 L54 62 L72 62 L76 84 M54 62 L46 50 M72 62 L80 50 M63 44 L63 62" />
      <path className="stroke-primary" fill="none" strokeWidth="4" strokeLinecap="round" d="M30 84 H98" />
      <Eyes points={[[22, 61]]} r={2.8} delay={delay} />
      <path {...LINE} strokeWidth={1.8} d="M17 68 q4 2 7 0" />
    </>
  ),
  other: () => (
    <>
      <ellipse className="fill-muted" {...OUTLINE} cx="60" cy="72" rx="17" ry="14" />
      <ellipse className="fill-muted" {...OUTLINE} cx="38" cy="54" rx="7" ry="8.5" />
      <ellipse className="fill-muted" {...OUTLINE} cx="51" cy="41" rx="7" ry="8.5" />
      <ellipse className="fill-muted" {...OUTLINE} cx="69" cy="41" rx="7" ry="8.5" />
      <ellipse className="fill-muted" {...OUTLINE} cx="82" cy="54" rx="7" ry="8.5" />
      <path className="fill-primary" d="M86 84 c0 -3 4 -4 5 -1 c1 -3 5 -2 5 1 c0 3 -5 6 -5 6 c0 0 -5 -3 -5 -6 Z" />
    </>
  ),
};

export type SpeciesAvatarProps = {
  /** Pet type (e.g. "Dog", "Small mammal"); unknown types get the paw-print art. */
  type?: string | null;
  /** Photo hint, used when the type is "Other" (e.g. "rabbit"). */
  hint?: string | null;
  /** Pet name for the accessible label; omit with `decorative`. */
  name?: string;
  decorative?: boolean;
  className?: string;
  /** Stagger blinks between neighboring cards. */
  blinkOffset?: number;
};

/** Square inline-SVG avatar that scales to its container. */
export function SpeciesAvatar({ type, hint, name, decorative, className, blinkOffset = 0 }: SpeciesAvatarProps) {
  const art = speciesArt(type, hint);
  const label = `${name ? `${name}, ` : ''}${SPECIES_ART_LABEL[art]} illustration`;
  const delay = (Math.abs(blinkOffset) % 3) as 0 | 1 | 2;
  return (
    <svg
      viewBox="0 0 120 120"
      className={cn('text-muted-foreground', className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
      data-species={art}
    >
      <circle className="fill-primary/10" cx="60" cy="60" r="56" />
      {ART[art](delay)}
    </svg>
  );
}

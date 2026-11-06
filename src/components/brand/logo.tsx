import { cn } from '@/lib/utils';
import styles from './logo.module.css';
import {
  LOGO_EAVE_NODES,
  LOGO_HUB_NODE,
  LOGO_ROOF_PATH,
  LOGO_STROKE_WIDTH,
  LOGO_VIEWBOX,
  LOGO_WALLS_PATH,
  LOGO_WINDOWS,
} from './logo-artwork';

const INTRO_SESSION_KEY = 'homehub:logo-intro-played';

// Runs while the server HTML is parsed, right after the <svg> and before the
// browser paints it, so a reload later in the same tab session never replays
// the intro (and nothing waits for hydration). Failures (storage blocked) only
// mean the intro may replay; they never hide the mark.
const INTRO_GUARD_SCRIPT = `(function(){try{var s=document.currentScript,svg=s&&s.previousElementSibling;if(!svg)return;if(sessionStorage.getItem('${INTRO_SESSION_KEY}')){svg.setAttribute('data-intro-played','')}else{sessionStorage.setItem('${INTRO_SESSION_KEY}','1')}}catch(e){}})();`;

export type LogoProps = {
  /** Rendered width and height in CSS pixels. Fixed so the mark never shifts layout. */
  size?: number;
  /** `mark` is the house only; `wordmark` adds the HomeHub name beside it. */
  variant?: 'mark' | 'wordmark';
  /** Play the one-time intro (roof draws on, windows light up). Use once per page, in the header. */
  animated?: boolean;
  /** Accessible name. Omit when adjacent text already names HomeHub; the mark is then decorative. */
  title?: string;
  className?: string;
};

/**
 * The HomeHub brand mark: a house whose roof is a hub-and-node connection.
 * Colored with `currentColor`, which defaults to the theme accent `hsl(var(--primary))`.
 */
export function Logo({ size = 24, variant = 'mark', animated = false, title, className }: LogoProps) {
  const mark = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={LOGO_VIEWBOX}
      width={size}
      height={size}
      fill="none"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={cn(animated && styles.intro)}
      // The guard script may add data-intro-played before hydration.
      suppressHydrationWarning
    >
      <path
        d={LOGO_WALLS_PATH}
        stroke="currentColor"
        strokeWidth={LOGO_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className={styles.roof}
        d={LOGO_ROOF_PATH}
        pathLength={1}
        stroke="currentColor"
        strokeWidth={LOGO_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {LOGO_WINDOWS.map((window) => (
        <rect key={window.x} className={styles.window} fill="currentColor" {...window} />
      ))}
      {LOGO_EAVE_NODES.map((node) => (
        <circle key={node.cx} className={styles.node} fill="currentColor" {...node} />
      ))}
      <circle className={styles.node} fill="currentColor" {...LOGO_HUB_NODE} />
    </svg>
  );

  return (
    <span className={cn(styles.root, variant === 'wordmark' && 'items-center gap-2', className)}>
      {mark}
      {animated && <script dangerouslySetInnerHTML={{ __html: INTRO_GUARD_SCRIPT }} />}
      {variant === 'wordmark' && (
        <span className="font-headline text-xl font-bold text-foreground">HomeHub</span>
      )}
    </span>
  );
}

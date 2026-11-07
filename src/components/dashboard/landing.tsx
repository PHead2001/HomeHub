'use client';

/**
 * Signed-out landing page (H03), shown at `/` to visitors who are not signed in.
 * A sample house assembles piece by piece as you scroll: each feature step brings
 * the next layer, and that module's tile flies into its room. It ends on the one
 * call to action, "Sign in with Google". No module navigation.
 *
 * Kept light for Lighthouse (>= 90 on mobile): fictional data in code, no
 * Firestore reads, no animation library (IntersectionObserver plus CSS
 * transitions on opacity/transform), a fixed aspect ratio so nothing shifts, and
 * the signed-in dashboard lives in a separate chunk. Under reduced motion the
 * whole house shows at once.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CheckSquare, Dog, LogIn, PawPrint, ShoppingCart, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';
import { floorPoint, layoutHouse } from '@/lib/dashboard/house-layout';
import { LANDING_STEPS, landingStage, moduleVisible, pieceVisible, SAMPLE_ROOMS, type LandingModule, type LandingPiece } from '@/lib/dashboard/landing-scene';
import styles from './dashboard.module.css';

const MODULE_ICON: Record<LandingModule, LucideIcon> = {
  chores: CheckSquare,
  shopping: ShoppingCart,
  pets: PawPrint,
  maintenance: Wrench,
};

const layout = layoutHouse(SAMPLE_ROOMS.map((room) => room.id));
const roomById = new Map(layout.rooms.map((room) => [room.id, room]));
const noSubscribe = () => () => undefined;
/**
 * Whether the browser can observe scrolling. The server snapshot assumes it can, so
 * the server HTML starts the house at stage 0 like the first client render (a
 * mismatch would leave the finished house in the DOM); a browser without
 * IntersectionObserver re-renders with the finished house right after hydration.
 */
const useCanObserve = () => useSyncExternalStore(noSubscribe, () => typeof IntersectionObserver !== 'undefined', () => true);

const pts = (list: Array<{ x: number; y: number }>) => list.map((p) => `${p.x},${p.y}`).join(' ');

function Piece({ name, stage, children }: { name: LandingPiece; stage: number; children: ReactNode }) {
  return (
    <g className={styles.piece} data-piece={name} data-on={pieceVisible(name, stage) ? 'true' : 'false'}>
      {children}
    </g>
  );
}

/** The sample house: decorative and `aria-hidden`; the steps carry the text. */
function SampleHouse({ stage }: { stage: number }) {
  const { body, apex, width, height, groundY } = layout;
  const kitchen = roomById.get('kitchen')!;
  const bedroom = roomById.get('bedroom')!;
  const living = roomById.get('living')!;
  const bowl = floorPoint(kitchen, 0.86);
  const dog = floorPoint(living, 0.35);
  const cat = { x: bowl.x - 14, y: bowl.y };
  return (
    <div
      aria-hidden
      className="relative w-full"
      style={{ aspectRatio: `${width} / ${height}` }}
      data-testid="landing-house"
      data-stage={stage}
    >
      <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full overflow-visible">
        <Piece name="foundation" stage={stage}>
          <rect x="0" y={groundY} width={width} height={height - groundY} className="fill-secondary/70" />
          <polygon points={pts(layout.sideWall)} className="fill-muted stroke-border" strokeWidth="1.5" />
          <rect x={body.x} y={body.y} width={body.w} height={body.h} className="fill-background/40 stroke-border" strokeWidth="2" />
        </Piece>
        <Piece name="rooms" stage={stage}>
          {layout.rooms.map((room) => {
            const i = 9;
            const { x, y, w, h } = room;
            return (
              <g key={room.id}>
                <rect x={x + i} y={y + i} width={w - 2 * i} height={h - 2 * i} className={room.id === 'kitchen' ? 'fill-warning/20' : room.id === 'living' ? 'fill-primary/15' : 'fill-card'} />
                <polygon points={pts([{ x, y }, { x: x + w, y }, { x: x + w - i, y: y + i }, { x: x + i, y: y + i }])} className="fill-muted/70" />
                <polygon points={pts([{ x, y: y + h }, { x: x + w, y: y + h }, { x: x + w - i, y: y + h - i }, { x: x + i, y: y + h - i }])} className="fill-secondary" />
                <rect x={x} y={y} width={w} height={h} className="fill-none stroke-border" strokeWidth="1.5" />
              </g>
            );
          })}
        </Piece>
        <Piece name="roof" stage={stage}>
          <polygon points={pts(layout.roofSide)} className="fill-muted stroke-border" strokeWidth="1.5" strokeLinejoin="round" />
          <polygon points={pts(layout.roofFront)} className="fill-secondary stroke-border" strokeWidth="2" strokeLinejoin="round" />
          <circle cx={apex.x} cy={body.y - 22} r="10" className="fill-background stroke-border" strokeWidth="2" />
        </Piece>
        <Piece name="pets" stage={stage}>
          <path d={`M${bowl.x - 8} ${bowl.y - 5}h16l-3 6h-10z`} className="fill-warning" />
          {[dog, cat].map((p, index) => (
            <g key={index} transform={`translate(${p.x} ${p.y})`}>
              <circle cx="0" cy="-9" r="9" className={cn('fill-card', index === 1 ? 'stroke-warning' : 'stroke-border')} strokeWidth="1.5" />
              {index === 0
                ? <Dog x={-6} y={-15} width={12} height={12} className="text-foreground" />
                : <PawPrint x={-6} y={-15} width={12} height={12} className="text-foreground" />}
            </g>
          ))}
        </Piece>
        <Piece name="details" stage={stage}>
          <rect x={apex.x + body.w / 4} y={body.y - 50} width="16" height="30" rx="2" className="fill-muted stroke-border" strokeWidth="1.5" />
          <circle cx={apex.x} cy={body.y - 22} r="7" className="fill-warning/80" />
          {layout.rooms.map((room) => (
            <rect key={room.id} x={room.x + room.w - 33} y={room.y + 16} width="14" height="10" rx="1" className="fill-warning/70" />
          ))}
          <rect x={bedroom.x + 14} y={bedroom.y + bedroom.h - 30} width="40" height="16" rx="3" className="fill-primary/30" />
        </Piece>
      </svg>
      {/* Module tiles fly in from the side to their rooms. */}
      {LANDING_STEPS.map((step) => {
        const room = roomById.get(step.roomId)!;
        const Icon = MODULE_ICON[step.module];
        return (
          <span
            key={step.module}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${room.center.x}%`, top: `${room.center.y - 4}%` }}
          >
            <span
              className={cn(styles.flyChip, 'flex h-7 w-7 items-center justify-center rounded-lg border bg-card text-primary shadow-raised sm:h-8 sm:w-8')}
              data-testid={`landing-chip-${step.module}`}
              data-on={moduleVisible(step.module, stage) ? 'true' : 'false'}
            >
              <Icon className="h-4 w-4" />
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function Landing() {
  const { signInWithGoogle, loading } = useAuth();
  const { toastError } = useToast();
  const reduced = useReducedMotion();
  const [reached, setReached] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const stepRefs = useRef<Array<HTMLElement | null>>([]);
  const canObserve = useCanObserve();
  // Without IntersectionObserver (very old browsers) the finished house shows at once.
  const stage = landingStage(reached, reduced || !canObserve);

  useEffect(() => {
    if (reduced || !canObserve) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number((entry.target as HTMLElement).dataset.step);
        // Reaching a step shows it and everything before it; the house never comes apart.
        setReached((previous) => Math.max(previous, index + 1));
      }
    }, { rootMargin: '0px 0px -35% 0px', threshold: 0.2 });
    stepRefs.current.forEach((element) => element && observer.observe(element));
    return () => observer.disconnect();
  }, [reduced, canObserve]);

  const signIn = async () => {
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (error) {
      toastError(error, 'Could not sign in');
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 md:py-14" data-testid="landing">
      <div className="grid gap-x-10 gap-y-4 md:grid-cols-2">
        <div className="md:col-start-1 md:row-start-1">
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Sparkles aria-hidden className="h-3.5 w-3.5" /> Your home, alive
          </p>
          <h1 className="font-headline text-4xl font-bold tracking-tight md:text-5xl">Welcome Home</h1>
          <p className="mt-4 max-w-md text-lg text-muted-foreground">
            HomeHub keeps chores, shopping, pets and upkeep in one place, and shows your whole household at a glance.
          </p>
        </div>

        <div className="sticky top-14 z-10 -mx-4 self-start bg-background/90 px-4 py-2 md:top-24 md:col-start-2 md:row-span-2 md:row-start-1 md:mx-0 md:bg-transparent md:px-0">
          <SampleHouse stage={stage} />
          <p className="mt-1 text-center text-xs text-muted-foreground">Sample household for illustration.</p>
        </div>

        <div className="md:col-start-1 md:row-start-2">
          <section aria-labelledby="landing-features">
            <h2 id="landing-features" className="sr-only">What HomeHub does</h2>
            <ol className="space-y-[18vh] pb-[8vh] pt-[4vh] md:space-y-[28vh]">
              {LANDING_STEPS.map((step, index) => {
                const Icon = MODULE_ICON[step.module];
                return (
                  <li
                    key={step.module}
                    ref={(element) => {
                      stepRefs.current[index] = element;
                    }}
                    data-step={index}
                    data-testid={`landing-step-${step.module}`}
                    className="rounded-xl border bg-card p-5 shadow-raised"
                  >
                    <Icon aria-hidden className="h-6 w-6 text-primary" />
                    <h3 className="mt-3 font-headline text-lg font-semibold">{step.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
                  </li>
                );
              })}
            </ol>
          </section>

          <section
            ref={(element) => {
              stepRefs.current[LANDING_STEPS.length] = element;
            }}
            // Reaching the call to action always completes the house, even on screens
            // too tall to scroll the last step into the observed band.
            data-step={LANDING_STEPS.length - 1}
            className="mt-4 rounded-2xl border bg-card p-8 text-center shadow-raised"
          >
            <h2 className="font-headline text-2xl font-semibold">Bring your household together</h2>
            <p className="mx-auto mt-2 max-w-md text-muted-foreground">Create a household or join one with an invite code after you sign in.</p>
            <Button size="lg" className="mt-6" onClick={signIn} disabled={loading || signingIn}>
              <LogIn aria-hidden className="mr-2 h-4 w-4" />
              Sign in with Google
            </Button>
          </section>
        </div>
      </div>
    </div>
  );
}

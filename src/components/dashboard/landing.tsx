'use client';

/**
 * Signed-out landing page (H03), shown at `/` to visitors who are not signed in.
 * A short page that shows the living house with clearly fictional sample data,
 * reveals what each module does as you scroll, and ends on one call to action.
 * No module navigation, no real household content, no data reads.
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { CheckSquare, LogIn, PawPrint, ShoppingCart, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { DURATION, EASE } from '@/lib/motion';
import type { DashboardFacts } from '@/lib/dashboard/facts';
import { LivingHouse } from './living-house';

/** Sample household for the illustration. Fictional; never read from Firestore. */
export function sampleFacts(now: Date): DashboardFacts {
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  return {
    chores: {
      mineOpen: 3,
      mineOverdue: 1,
      mineDueToday: 2,
      todayTotal: 4,
      todayDone: 2,
      overdueTotal: 1,
      nextUp: [],
      rooms: [
        { id: 'kitchen', name: 'Kitchen', overdue: 1, dueToday: 0, upcoming: 0, doneToday: 0, status: 'overdue', chores: [] },
        { id: 'living', name: 'Living Room', overdue: 0, dueToday: 1, upcoming: 0, doneToday: 0, status: 'due', chores: [] },
        { id: 'bedroom', name: 'Bedroom', overdue: 0, dueToday: 0, upcoming: 1, doneToday: 2, status: 'clear', chores: [] },
      ],
    },
    pantry: { total: 18, fridgeItems: 7, expired: 0, expiringSoon: 1, nearest: [] },
    maintenance: { overdue: 0, dueSoon: 1, needsAttention: 0, next: null, items: [], vehicleDue: false, climateDue: true, vehicles: 1 },
    pets: {
      hungry: 1,
      unknown: 0,
      pets: [
        { id: 'sample-dog', name: 'Biscuit', type: 'Dog', lastFedAt: hoursAgo(2), lastFedBy: null, fed: true, countLabel: '2 of 2 today', headline: 'Fed 2 h ago' },
        { id: 'sample-cat', name: 'Miso', type: 'Cat', lastFedAt: hoursAgo(14), lastFedBy: null, fed: false, countLabel: '0 of 2 today', headline: 'Fed yesterday' },
      ],
    },
  };
}

const FEATURES: Array<{ icon: LucideIcon; title: string; body: string }> = [
  { icon: CheckSquare, title: 'Chores that finish themselves', body: 'Rooms glow when something is overdue and sparkle when the work is done. Recurring chores schedule themselves.' },
  { icon: ShoppingCart, title: 'Lists for the whole house', body: 'Shared shopping lists that work offline in the store, with a pantry that knows what expires soon.' },
  { icon: PawPrint, title: 'Pets, fed on time', body: 'See at a glance who was fed and when, and log a meal in one tap.' },
  { icon: Wrench, title: 'Maintenance without the binder', body: 'Filters, warranties, tire rotations and registrations, reminded before they are due.' },
];

/** Inert wrapper: the sample house is an illustration, so its links are not reachable. */
function Illustration({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.setAttribute('inert', '');
  }, []);
  return (
    <div ref={ref} aria-hidden className="pointer-events-none select-none">
      {children}
    </div>
  );
}

export function Landing() {
  const { signInWithGoogle, loading } = useAuth();
  const { toastError } = useToast();
  const [now] = useState(() => new Date());
  const [signingIn, setSigningIn] = useState(false);

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

  const reveal = {
    initial: { opacity: 0, y: 16 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, margin: '0px 0px -10% 0px' },
    transition: { duration: DURATION.ui, ease: EASE.standard },
  } as const;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-10 md:py-16" data-testid="landing">
      <section className="grid items-center gap-8 md:grid-cols-2">
        <div>
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Sparkles aria-hidden className="h-3.5 w-3.5" /> Your home, alive
          </p>
          <h1 className="font-headline text-4xl font-bold tracking-tight md:text-5xl">Welcome Home</h1>
          <p className="mt-4 max-w-md text-lg text-muted-foreground">
            HomeHub keeps chores, shopping, pets and upkeep in one place, and shows your whole household at a glance.
          </p>
          <Button size="lg" className="mt-6" onClick={signIn} disabled={loading || signingIn}>
            <LogIn aria-hidden className="mr-2 h-4 w-4" />
            Sign in with Google
          </Button>
        </div>
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: DURATION.ui, ease: EASE.standard }}>
          <Illustration>
            <LivingHouse facts={sampleFacts(now)} title="The sample house" demo now={now} />
          </Illustration>
          <p className="mt-2 text-center text-xs text-muted-foreground">Sample household for illustration.</p>
        </motion.div>
      </section>

      <section aria-labelledby="landing-features" className="mt-16">
        <h2 id="landing-features" className="sr-only">What HomeHub does</h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <motion.li key={title} {...reveal} className="rounded-xl border bg-card p-5 shadow-raised">
              <Icon aria-hidden className="h-6 w-6 text-primary" />
              <h3 className="mt-3 font-headline text-lg font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </motion.li>
          ))}
        </ul>
      </section>

      <motion.section {...reveal} className="mt-16 rounded-2xl border bg-card p-8 text-center shadow-raised">
        <h2 className="font-headline text-2xl font-semibold">Bring your household together</h2>
        <p className="mx-auto mt-2 max-w-md text-muted-foreground">Create a household or join one with an invite code after you sign in.</p>
      </motion.section>
    </div>
  );
}

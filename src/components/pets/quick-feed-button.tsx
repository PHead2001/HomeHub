'use client';

import * as React from 'react';
import { Loader2, Utensils } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { playFeedback } from '@/lib/feedback';
import { ShortcutHint } from '@/components/ui/shortcut-hint';
import { formatPortion, type FeedingPlan, type FeedingStatus, type QuickFeedFood } from '@/lib/pets/care';
import type { KnownFeedings } from '@/lib/pets/feed-decision';
import type { FeedPetResult } from '@/lib/pets/feed-operation';
import type { FoodType } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { FeedAgainDialog, useFeedAction, type FeedAction } from './use-feed-action';
import styles from './pets.module.css';

const PAWS = [
  { x: '-34px', y: '-30px', r: '-20deg' },
  { x: '-12px', y: '-42px', r: '-6deg' },
  { x: '12px', y: '-44px', r: '8deg' },
  { x: '34px', y: '-30px', r: '22deg' },
  { x: '0px', y: '-24px', r: '0deg' },
];

export function PawBurst({ className }: { className?: string }) {
  return (
    <span className={cn(styles.burst, className)} aria-hidden data-testid="paw-burst">
      {PAWS.map((paw, index) => (
        <svg
          key={index}
          viewBox="0 0 24 24"
          className={cn(styles.paw, 'fill-primary')}
          style={{ '--paw-x': paw.x, '--paw-y': paw.y, '--paw-rotate': paw.r, animationDelay: `${index * 30}ms` } as React.CSSProperties}
        >
          <ellipse cx="12" cy="15.5" rx="5" ry="4.2" />
          <circle cx="5.5" cy="9.5" r="2.2" />
          <circle cx="9.5" cy="5.5" r="2.2" />
          <circle cx="14.5" cy="5.5" r="2.2" />
          <circle cx="18.5" cy="9.5" r="2.2" />
        </svg>
      ))}
    </span>
  );
}

export type QuickFeedOptions = {
  petId: string;
  petName: string;
  plan: FeedingPlan;
  /** Today's status; null when it could not be loaded (no goal or celebration claims then). */
  status: FeedingStatus | null;
  /** Food type to log (`quickFeedFood`): not ready while the feeding history loads. */
  food: QuickFeedFood;
  /** Last feed and today's count from the loaded logs (the check's fallback while a pet has no feeding state). */
  known?: KnownFeedings | null;
};

export type FeedSource = 'tap' | 'hold';

export type QuickFeedController = {
  /** The member may log feedings (`pets.addLogs`). */
  allowed: boolean;
  saving: boolean;
  portion: string;
  /** Food type the feeding is logged with (the latest feeding's, else Dry). */
  foodType: FoodType;
  /** False until the feeding history has loaded; `feed` does nothing until then. */
  ready: boolean;
  /** Dry is used because the history could not be read. */
  foodFallback: boolean;
  /** Which control shows the paw burst, and a key that restarts it. */
  burst: { key: number; source: FeedSource } | null;
  /** The shared feed operation's UI state ("Feed again?" prompt, accept, cancel). */
  action: FeedAction;
  /** Logs one feeding, or opens "Feed again?"; resolves with the operation's result (null when nothing ran). */
  feed: (source: FeedSource) => Promise<FeedPetResult | null>;
};

/**
 * The quick feeding behind one-tap feeding, hold to feed and the `?feed=1`
 * confirm (H09): logs the planned portion with the latest food type through the
 * shared feed operation (`feedPet`, via `useFeedAction`), which first checks
 * whether someone fed the pet in the last 90 minutes or today is complete and
 * then asks "Feed again?". On success it plays opt-in feedback, starts the paw
 * burst (never under reduced motion), and the toast offers Undo for 10 s to
 * everyone who can log. A call while a feeding is saving is ignored.
 */
export function useQuickFeed({ petId, petName, plan, food, known }: QuickFeedOptions): QuickFeedController {
  const { foodType, ready, fallback: foodFallback } = food;
  const reducedMotion = useReducedMotion();
  const [burst, setBurst] = React.useState<QuickFeedController['burst']>(null);
  const sourceRef = React.useRef<FeedSource>('tap');
  const portion = formatPortion(plan.amount, plan.unit);
  // Today's count comes from the operation's committed state, not from this device's view.
  const reachedGoal = (result: { status: string; countToday: number }) =>
    Boolean(plan.perDay) && result.status === 'saved' && result.countToday === plan.perDay;
  const action = useFeedAction(petId, petName, {
    onFed: (result) => {
      playFeedback(reachedGoal(result) ? 'celebrate' : 'complete');
      if (!reducedMotion) setBurst({ key: Date.now(), source: sourceRef.current });
    },
    describe: (result) => ({
      title: reachedGoal(result) ? `${petName} is all fed for today` : `${petName} fed`,
      description: foodFallback ? `${portion} of dry food logged (last feeding unavailable).` : `${portion} logged.`,
    }),
  });
  const { allowed, run, saving } = action;

  React.useEffect(() => {
    if (!burst) return;
    const timer = window.setTimeout(() => setBurst(null), 1100);
    return () => window.clearTimeout(timer);
  }, [burst]);

  const feed = React.useCallback(async (source: FeedSource) => {
    // Never log before the history says which food the pet eats.
    if (!allowed || !ready || saving) return null;
    sourceRef.current = source;
    return run({ portion: { amount: plan.amount, unit: plan.unit }, food: foodType, known });
  }, [allowed, ready, saving, run, plan.amount, plan.unit, foodType, known]);

  return { allowed, saving, portion, foodType, ready, foodFallback, burst, action, feed };
}

/**
 * The confirm step of the "Log feeding" home-screen shortcut (`/pets?feed=1`):
 * names the pet, portion and food type with the last feeding ("Fed 12 min ago by
 * Sam"), and logs only on "Log feeding". A launcher shortcut never logs silently;
 * the Feed button itself is one tap. When the shared operation asks "Feed
 * again?", the question replaces the step in place (Feed again / Cancel).
 */
export function FeedConfirmPanel({
  petName,
  quick,
  onDone,
  titleId,
  lastFed,
}: {
  petName: string;
  quick: QuickFeedController;
  onDone: () => void;
  titleId: string;
  /** "Fed 12 min ago by Sam", when known. */
  lastFed?: string | null;
}) {
  const { action } = quick;
  if (action.prompt) {
    return (
      <div className="space-y-3" data-testid="feed-again-inline">
        <p id={titleId} role="alert" className="text-sm text-foreground">{action.prompt}</p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            className="flex-1"
            disabled={quick.saving}
            onClick={async () => {
              const result = await action.acceptPrompt();
              if (result && result.status !== 'needsConfirm') onDone();
            }}
          >
            {quick.saving ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <Utensils aria-hidden className="mr-2 h-4 w-4" />}
            Feed again
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { action.cancelPrompt(); onDone(); }}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {quick.ready ? (
        <p id={titleId} className="text-sm text-foreground">
          Log <span className="font-semibold">{quick.portion}</span> of {quick.foodType.toLowerCase()} food for{' '}
          <span className="font-semibold">{petName}</span>?
          {lastFed && <span className="mt-1 block text-xs text-muted-foreground" data-testid="feed-confirm-last-fed">{lastFed}</span>}
          {quick.foodFallback && (
            <span className="mt-1 block text-xs text-muted-foreground">The last feeding couldn&apos;t be loaded, so this logs dry food.</span>
          )}
        </p>
      ) : (
        <p id={titleId} className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="feed-confirm-loading">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Checking {petName}&apos;s last feeding…
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="flex-1"
          disabled={quick.saving || !quick.ready}
          onClick={async () => {
            const result = await quick.feed('tap');
            // Stays open for "Feed again?" and after a failure (the toast offers Retry).
            if (result && result.status !== 'needsConfirm') onDone();
          }}
        >
          {quick.saving ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <Utensils aria-hidden className="mr-2 h-4 w-4" />}
          Log feeding
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export type QuickFeedButtonProps = QuickFeedOptions & {
  /** A controller shared with hold to feed; without one the button owns its own. */
  controller?: QuickFeedController;
  /** Id of hint text (e.g. "or press and hold the photo") for `aria-describedby`. */
  describedBy?: string;
  className?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
};

/**
 * One-tap feeding at the planned portion (section 3 Pets, H09) and the accessible
 * alternative to hold to feed (owner decision): the tap logs at once and the
 * toast confirms what was logged, with Undo for 10 s for everyone who can log.
 * A single reversible tap is the alternative to holding; the tap asks first only
 * when the shared operation's last-fed check says so ("Sam fed Rex 12 min ago.
 * Feed again?", in `FeedAgainDialog`, which also serves hold to feed), and the
 * "Log feeding" home-screen shortcut always asks (`FeedPickerDialog`), because
 * nothing on a pet was tapped there. The full form stays on the pet page behind
 * "Log with details".
 */
export function QuickFeedButton({ controller, describedBy, className, size, variant = 'default', ...options }: QuickFeedButtonProps) {
  const own = useQuickFeed(options);
  const quick = controller ?? own;

  if (!quick.allowed) return null;

  return (
    <span className={cn('relative inline-flex', className)}>
      <ShortcutHint shortcut="log-feeding" label="Log a feeding from anywhere">
      <Button
        type="button"
        size={size}
        variant={variant}
        className="w-full"
        onClick={() => void quick.feed('tap')}
        disabled={quick.saving || !quick.ready}
        aria-label={`Feed ${options.petName}, ${quick.portion}`}
        aria-describedby={describedBy}
      >
        {quick.saving ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <Utensils aria-hidden className="mr-2 h-4 w-4" />}
        Feed · {quick.portion}
      </Button>
      </ShortcutHint>
      {quick.burst?.source === 'tap' ? <PawBurst key={quick.burst.key} /> : null}
      <FeedAgainDialog action={quick.action} petName={options.petName} />
    </span>
  );
}

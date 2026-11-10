'use client';

import * as React from 'react';
import { Loader2, Utensils } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useToast } from '@/hooks/use-toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import { playFeedback } from '@/lib/feedback';
import { ShortcutHint } from '@/components/ui/shortcut-hint';
import { formatPortion, loggerName, type FeedingPlan, type FeedingStatus, type QuickFeedFood } from '@/lib/pets/care';
import type { FoodType } from '@/lib/pets/types';
import { cn } from '@/lib/utils';
import { addFeedingLog, deletePetLog } from './pet-log-api';
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
  feed: (source: FeedSource) => Promise<void>;
};

/**
 * The one feeding writer behind one-tap feeding and hold to feed (H09): logs the
 * planned portion with the latest food type through `addFeedingLog`, plays opt-in
 * feedback, starts the paw burst (never under reduced motion) and offers Undo to
 * members who may delete logs. A call while a feeding is saving is ignored.
 */
export function useQuickFeed({ petId, petName, plan, status, food }: QuickFeedOptions): QuickFeedController {
  const { foodType, ready, fallback: foodFallback } = food;
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const reducedMotion = useReducedMotion();
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const [burst, setBurst] = React.useState<QuickFeedController['burst']>(null);
  const allowed = Boolean(permissions['pets.addLogs']);
  const canUndo = Boolean(permissions['pets.deleteLogs']);
  const portion = formatPortion(plan.amount, plan.unit);

  React.useEffect(() => {
    if (!burst) return;
    const timer = window.setTimeout(() => setBurst(null), 1100);
    return () => window.clearTimeout(timer);
  }, [burst]);

  const feed = React.useCallback(async (source: FeedSource) => {
    const householdId = currentUser?.householdId;
    // Never log before the history says which food the pet eats.
    if (!allowed || !ready || !householdId || !currentUser || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const ref = await addFeedingLog(householdId, petId, {
        amount: plan.amount,
        unit: plan.unit,
        foodType,
        loggedByUid: currentUser.uid,
        loggedByName: loggerName(currentUser),
      });
      const reachedGoal = Boolean(plan.perDay && status) && status!.fedToday + 1 === plan.perDay;
      playFeedback(reachedGoal ? 'celebrate' : 'complete');
      if (!reducedMotion) setBurst({ key: Date.now(), source });
      const { dismiss } = toast({
        group: 'pet-feed',
        title: reachedGoal ? `${petName} is all fed for today` : `${petName} fed`,
        description: foodFallback ? `${portion} of dry food logged (last feeding unavailable).` : `${portion} logged.`,
        duration: canUndo ? UNDO_WINDOW_MS : undefined,
        action: canUndo ? (
          <ToastAction
            altText={`Undo feeding for ${petName}`}
            onClick={async () => {
              dismiss();
              try {
                await deletePetLog(householdId, petId, 'feeding-logs', ref.id);
              } catch (error) {
                toastError(error, "Couldn't undo the feeding");
              }
            }}
          >
            Undo
          </ToastAction>
        ) : undefined,
      });
    } catch (error) {
      toastError(error, `Couldn't log ${petName}'s feeding`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [allowed, ready, foodFallback, canUndo, currentUser, petId, petName, plan.amount, plan.unit, plan.perDay, foodType, status, portion, reducedMotion, toast, toastError]);

  return { allowed, saving, portion, foodType, ready, foodFallback, burst, feed };
}

/**
 * The confirm step of the "Log feeding" home-screen shortcut (`/pets?feed=1`):
 * names the pet, portion and food type, and logs only on "Log feeding". A
 * launcher shortcut never logs silently; the Feed button itself is one tap.
 */
export function FeedConfirmPanel({
  petName,
  quick,
  onDone,
  titleId,
}: {
  petName: string;
  quick: QuickFeedController;
  onDone: () => void;
  titleId: string;
}) {
  return (
    <div className="space-y-3">
      {quick.ready ? (
        <p id={titleId} className="text-sm text-foreground">
          Log <span className="font-semibold">{quick.portion}</span> of {quick.foodType.toLowerCase()} food for{' '}
          <span className="font-semibold">{petName}</span>?
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
          onClick={() => {
            onDone();
            void quick.feed('tap');
          }}
        >
          <Utensils aria-hidden className="mr-2 h-4 w-4" /> Log feeding
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
 * toast confirms what was logged, with Undo for 10 s for members who may delete
 * logs. A single reversible tap is the alternative to holding; only the "Log
 * feeding" home-screen shortcut asks first (`FeedPickerDialog`), because nothing
 * on a pet was tapped there. The full form stays on the pet page behind "Log
 * with details".
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
    </span>
  );
}

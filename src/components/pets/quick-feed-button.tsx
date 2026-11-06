'use client';

import * as React from 'react';
import { Loader2, Utensils } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useToast } from '@/hooks/use-toast';
import { playFeedback } from '@/lib/feedback';
import { formatPortion, loggerName, type FeedingPlan, type FeedingStatus } from '@/lib/pets/care';
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

function PawBurst() {
  return (
    <span className={styles.burst} aria-hidden>
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

export type QuickFeedButtonProps = {
  petId: string;
  petName: string;
  plan: FeedingPlan;
  /** Today's status; null when it could not be loaded (no goal or celebration claims then). */
  status: FeedingStatus | null;
  /** Food type of the last feeding, reused for one-tap feeding. */
  foodType?: FoodType;
  className?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
};

/**
 * One-tap feeding at the planned portion (section 3 Pets, H09). The full form
 * stays on the pet page behind "Log with details". Plays opt-in feedback, shows
 * a paw-print burst (skipped under reduced motion) and offers Undo to members who
 * may delete logs.
 */
export function QuickFeedButton({ petId, petName, plan, status, foodType = 'Dry', className, size, variant = 'default' }: QuickFeedButtonProps) {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const reducedMotion = useReducedMotion();
  const [saving, setSaving] = React.useState(false);
  const [burstKey, setBurstKey] = React.useState(0);

  React.useEffect(() => {
    if (!burstKey) return;
    const timer = window.setTimeout(() => setBurstKey(0), 1100);
    return () => window.clearTimeout(timer);
  }, [burstKey]);

  if (!permissions['pets.addLogs']) return null;

  const portion = formatPortion(plan.amount, plan.unit);

  const feed = async () => {
    const householdId = currentUser?.householdId;
    if (!householdId || !currentUser || saving) return;
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
      if (!reducedMotion) setBurstKey(Date.now());
      const canUndo = Boolean(permissions['pets.deleteLogs']);
      const { dismiss } = toast({
        title: reachedGoal ? `${petName} is all fed for today` : `${petName} fed`,
        description: `${portion} logged.`,
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
      setSaving(false);
    }
  };

  return (
    <span className={cn('relative inline-flex', className)}>
      <Button
        type="button"
        size={size}
        variant={variant}
        className="w-full"
        onClick={feed}
        disabled={saving}
        aria-label={`Feed ${petName}, ${portion}`}
      >
        {saving ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <Utensils aria-hidden className="mr-2 h-4 w-4" />}
        Feed · {portion}
      </Button>
      {burstKey ? <PawBurst key={burstKey} /> : null}
    </span>
  );
}

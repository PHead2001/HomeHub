'use client';

/**
 * Dashboard one-tap actions (HP-33a, HP-33b, HP-33d) and the household's work for
 * today (HP-32a).
 *
 * - Fed: the Pets module's shared feed operation through `useFeedAction` (the reader's
 *   real `pets.addLogs` permission and attribution, the "Feed again?" check, server time
 *   and a 10 s Undo), with the pet's usual portion and latest food type, as the Pets
 *   one-tap Feed logs it.
 * - Done: the Chores server completion actions through `complete-client.ts` (eligibility
 *   refusals said honestly, the completer credited, the occurrence keeps its identity),
 *   confetti only after the server completed it, and a 10 s Undo through the server undo.
 *   Offline nothing is queued: "You're offline. Not completed."
 *
 * Every control is a real button beside the tile's link (never inside it), at least 44 px
 * and 48 px on coarse pointers (`styles.target`), with a saving and a failed state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Check, Loader2, RotateCcw } from 'lucide-react';
import { ToastAction } from '@/components/ui/toast';
import { useConfetti } from '@/components/chores/confetti';
import { FeedAgainDialog, useFeedAction } from '@/components/pets/use-feed-action';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { playFeedback } from '@/lib/feedback';
import { dayFromKey } from '@/lib/chores/dates';
import {
  CHORE_UNDO_MS,
  completeChoresOnServer,
  completionFailureMessage,
  undoCompletionOnServer,
  undoTicket,
  type UndoTicket,
} from '@/lib/chores/complete-client';
import { formatPortion } from '@/lib/pets/care';
import { memberName, type ChoreEntry, type PetState } from '@/lib/dashboard/facts';
import { householdSummary, summaryPhrase } from '@/lib/dashboard/household-summary';
import { reconcileDoneStates } from '@/lib/dashboard/done-states';
import { cn } from '@/lib/utils';
import styles from './dashboard.module.css';

export type ActionState = 'saving' | 'done' | 'failed';

/**
 * Done for dashboard chores. The dashboard reads chores with live listeners, so it
 * never patches them locally: a completed chore leaves the list when its snapshot
 * arrives, and until then its row says "Done". `liveIds` is the live list's chore ids:
 * a chore that left it after being completed here and later reappears was reopened
 * elsewhere, so its local Done state is dropped and its button works again.
 */
export function useChoreDone(liveIds?: readonly string[]) {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const { burst, layer } = useConfetti();
  const [states, setStates] = useState<Record<string, ActionState>>({});
  const busy = useRef(new Set<string>());
  const gone = useRef<ReadonlySet<string>>(new Set());
  const liveKey = liveIds?.join('|');
  useEffect(() => {
    if (!liveIds) return;
    setStates((current) => {
      const next = reconcileDoneStates({ states: current, gone: gone.current }, liveIds, 'done' as ActionState);
      gone.current = next.gone;
      return next.states === current ? current : { ...next.states };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);
  const householdId = currentUser?.householdId ?? null;
  const set = useCallback((id: string, state: ActionState | null) => {
    setStates((current) => {
      const next = { ...current };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });
  }, []);

  const undo = useCallback(async (chore: Pick<ChoreEntry, 'id' | 'task'>, ticket: UndoTicket) => {
    if (!householdId) return;
    const result = await undoCompletionOnServer(householdId, ticket);
    if (!result.ok) {
      toast({ variant: 'destructive', title: completionFailureMessage(result, 'undo') });
      return;
    }
    if (result.data.status === 'stale' || result.data.status === 'missing') {
      // Someone completed it again, or deleted it, meanwhile: left as stored.
      toast({ title: 'Already changed', description: 'Someone changed this chore since, so it was left as it is.' });
    }
    set(chore.id, null);
  }, [householdId, set, toast]);

  const complete = useCallback(async (chore: Pick<ChoreEntry, 'id' | 'task'>, origin: HTMLElement | null) => {
    if (!householdId || busy.current.has(chore.id)) return;
    busy.current.add(chore.id);
    // Measured now: the row leaves the list once the server's change arrives.
    const rect = origin?.getBoundingClientRect() ?? null;
    set(chore.id, 'saving');
    try {
      const result = await completeChoresOnServer(householdId, [chore.id], { completeSubTasks: true });
      if (!result.ok) {
        set(chore.id, 'failed');
        toast({ variant: 'destructive', title: completionFailureMessage(result, 'complete') });
        return;
      }
      const outcome = result.data.find((entry) => entry.choreId === chore.id);
      if (!outcome || outcome.status === 'refused') {
        set(chore.id, null);
        if (outcome?.status === 'refused' && outcome.refused === 'early') {
          // CH-2: the server refuses a chore due after the household's today.
          toast({ title: 'Not due yet', description: `${chore.task} is due ${format(dayFromKey(outcome.dueDay), 'EEE, MMM d')}. It can be completed from that day.` });
        } else {
          toast({ variant: 'destructive', title: `${chore.task} was not completed.`, description: outcome ? 'It was deleted.' : undefined });
        }
        return;
      }
      set(chore.id, 'done');
      if (outcome.status === 'already') {
        const by = memberName(outcome.completion.completedByName);
        toast({ title: 'Already done', description: by ? `${chore.task} was already done by ${by}.` : `${chore.task} was already done.` });
        return;
      }
      // The existing completion sparkle, only once the server completed it.
      playFeedback('complete');
      burst(rect, 16);
      const ticket = undoTicket(outcome);
      const handle = toast({
        group: 'chore-complete',
        title: 'Done',
        description: `${chore.task} marked complete.`,
        duration: CHORE_UNDO_MS,
        action: ticket ? (
          <ToastAction altText={`Undo completing ${chore.task}`} onClick={() => { handle.dismiss(); void undo(chore, ticket); }}>
            Undo
          </ToastAction>
        ) : undefined,
      });
    } finally {
      busy.current.delete(chore.id);
    }
  }, [householdId, set, toast, burst, undo]);

  return { states, complete, layer };
}

export type ChoreDone = ReturnType<typeof useChoreDone>;

export function ActionButton({
  state, label, idle, onClick, testId, className, dataKey,
}: {
  state: ActionState | undefined;
  /** Accessible name in the idle state ("Mark Dishes done"). */
  label: string;
  /** Visible idle text ("Done", "Fed"). */
  idle: string;
  onClick: (button: HTMLButtonElement) => void;
  testId: string;
  className?: string;
  /** `data-tick-key` (the Shopping tile finds the next row's control by it). */
  dataKey?: string;
}) {
  const saving = state === 'saving';
  const done = state === 'done';
  const failed = state === 'failed';
  return (
    <button
      type="button"
      data-testid={testId}
      data-tick-key={dataKey}
      data-state={state ?? 'idle'}
      aria-label={failed ? `Retry: ${label}` : label}
      aria-busy={saving || undefined}
      disabled={saving || done}
      onClick={(event) => onClick(event.currentTarget)}
      className={cn(
        styles.target,
        'inline-flex shrink-0 items-center justify-center gap-1 rounded-md border px-3 text-sm font-medium transition-ui',
        done ? 'border-success/40 text-success' : failed ? 'border-destructive/50 text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-muted',
        'disabled:cursor-default',
        className,
      )}
    >
      {saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : done ? <Check aria-hidden className="h-4 w-4" /> : failed ? <RotateCcw aria-hidden className="h-4 w-4" /> : null}
      <span>{saving ? 'Saving…' : done ? idle : failed ? 'Retry' : idle}</span>
    </button>
  );
}

/** Rows listed in the tile; the wide layout (beside the house) shows the first only. */
const TILE_ROWS = 3;

/**
 * HP-32a: who has what today ("Sam: Dishes (overdue) · You: Trash (today)"), under the
 * tile's headline inside its link. Beside the house it is one truncating line in place
 * of "N open for you" (HP-12d: the wide layout fits one screen); its full text is the
 * element's title. Overdue work comes first and folded missed instances are named.
 */
export function HouseholdSummaryLine({ work }: { work: ChoreEntry[] }) {
  if (work.length === 0) return null;
  const summary = householdSummary(work);
  return (
    <span className={cn(styles.choresSummary, 'block text-sm text-muted-foreground')} data-testid="household-summary" title={summary.text}>
      {summary.parts.map((part, index) => (
        <span key={part.key || 'unassigned'}>
          {index > 0 && ' · '}
          <span className={cn(part.overdue > 0 && 'text-warning')}>{summaryPhrase(part)}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * HP-33b: the most urgent chores with their assignee, room and Done, below the tile's
 * link. Overdue work comes first and folded missed instances are named, so nothing
 * overdue or missed is hidden; the rest is one link away ("+N more today", or beside the
 * house the tile itself).
 */
export function HouseholdChores({ work, total, canComplete, done }: { work: ChoreEntry[]; total: number; canComplete: boolean; done: ChoreDone }) {
  if (work.length === 0) return null;
  const rows = work.slice(0, TILE_ROWS);
  const more = total - rows.length;
  return (
    <div className={cn(styles.choresWork, 'flex min-w-0 flex-col gap-2')} data-testid="household-chores">
      <ul className="flex flex-col gap-1.5" aria-label="Today's household chores">
        {rows.map((chore, index) => {
          const meta = [chore.mine ? 'You' : chore.assignee ?? (chore.assigneeKey ? 'Someone' : 'Unassigned'), chore.room, chore.dueLabel].filter(Boolean).join(' · ');
          return (
            <li key={chore.id} className={cn('flex min-w-0 items-center justify-between gap-2', index > 0 && styles.wideHide)} data-testid={`household-chore-${chore.id}`}>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{chore.task}</span>
                <span className={cn('block truncate text-xs', chore.overdue ? 'text-warning' : 'text-muted-foreground')}>
                  {meta}
                  {chore.missed ? ` · +${chore.missed} earlier missed` : ''}
                </span>
              </span>
              {canComplete && (
                <ActionButton
                  state={done.states[chore.id]}
                  idle="Done"
                  label={`Mark ${chore.task} done`}
                  testId={`chore-done-${chore.id}`}
                  onClick={(button) => void done.complete(chore, button)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <Link href="/chores" className={cn(styles.hitSlop, styles.wideHide, 'self-start text-xs text-muted-foreground hover:text-foreground')} data-testid="household-chores-more">
          +{more} more today
        </Link>
      )}
    </div>
  );
}

/**
 * HP-33a: "Fed" for a pet that has not met today's feeding target. Logs the pet's usual
 * portion with its latest food type through the shared feed operation; "Feed again?"
 * when someone fed it in the last 90 minutes or today is complete; Undo for 10 s.
 */
export function PetFedButton({ pet, className }: { pet: PetState; className?: string }) {
  const feed = pet.feed;
  const portion = feed ? formatPortion(feed.amount, feed.unit) : '';
  const reachedGoal = (result: { status: string; countToday: number }) =>
    Boolean(feed?.perDay) && result.status === 'saved' && result.countToday === feed?.perDay;
  const action = useFeedAction(pet.id, pet.name, {
    onFed: (result) => playFeedback(reachedGoal(result) ? 'celebrate' : 'complete'),
    describe: (result) => ({
      title: reachedGoal(result) ? `${pet.name} is all fed for today` : `${pet.name} fed`,
      description: `${portion} logged.`,
    }),
  });
  const [failed, setFailed] = useState(false);
  if (!feed || !action.allowed || pet.fed !== false) return null;
  const run = async () => {
    setFailed(false);
    const result = await action.run({ portion: { amount: feed.amount, unit: feed.unit }, food: feed.foodType, known: feed.known });
    // Null after a real attempt: the operation failed (its toast offers Retry too).
    if (result === null) setFailed(true);
  };
  return (
    <>
      <ActionButton
        state={action.saving ? 'saving' : failed ? 'failed' : undefined}
        idle="Fed"
        label={`Mark ${pet.name} fed`}
        testId={`pet-fed-${pet.id}`}
        onClick={() => void run()}
        className={className}
      />
      <FeedAgainDialog action={action} petName={pet.name} />
    </>
  );
}

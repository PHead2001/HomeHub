// Client side of the maintenance server actions (M1): how the page calls them, the
// bounded wait, offline handling, and the user-facing copy for their answers.
import { format, isValid, parseISO } from 'date-fns';
import { auth } from '@/lib/firebase';
import type { MaintenanceActionResult } from '@/app/maintenance/actions';
import { callWithDeadline, type MaintenanceCallOutcome } from '@/lib/maintenance/action-call';

export { mileageWarningMessage } from '@/lib/maintenance/action-call';
import type { CompleteResult } from '@/lib/server/maintenance-operations';
import type { CompletionRefusal, KeptField } from '@/lib/maintenance/operations';

/** After this long without an answer the page says so and offers Retry (same op id). */
export const MAINTENANCE_ANSWER_DEADLINE_MS = 20_000;
export const NO_ANSWER_MESSAGE = 'No answer from HomeHub. It may have been saved.';
export const OFFLINE_MESSAGE = 'Needs a connection. Your entries are kept.';
export const CHANGED_MESSAGE = 'This changed since you opened it. The latest is shown now.';

export type { MaintenanceCallOutcome } from '@/lib/maintenance/action-call';

type Context = { idToken: string; householdId: string };

/** A fresh op id: one per press, reused only for the same unresolved request. */
export const newOpId = () =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Calls a maintenance server action with the current user's ID token. Offline it does not
 * try. The 20 s deadline covers fetching the token and the call together; no answer in
 * time (or a failure in transit) is `no_answer`, because the server may have saved it.
 */
export async function callMaintenanceAction<T>(
  householdId: string,
  call: (context: Context) => Promise<MaintenanceActionResult<T>>,
  deadlineMs = MAINTENANCE_ANSWER_DEADLINE_MS,
): Promise<MaintenanceCallOutcome<T>> {
  if (offline()) return { kind: 'offline' };
  const user = auth.currentUser;
  if (!user) return { kind: 'failed', message: 'Your sign-in could not be verified. Sign in again.' };
  return callWithDeadline(() => user.getIdToken(), idToken => call({ idToken, householdId }), deadlineMs, offline);
}

const day = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, 'MMM d') : value;
};
const miles = (value: unknown) => (typeof value === 'number' ? `${value.toLocaleString('en-US')} mi` : null);

const KEPT_COPY: Record<string, { label: string; show: (value: unknown) => string | null }> = {
  nextDueDate: { label: 'The due date', show: day },
  nextDueMileage: { label: 'The due mileage', show: miles },
  lastCompletedDate: { label: 'The last done date', show: day },
  lastCompletedMileage: { label: 'The last done mileage', show: miles },
  snoozedUntil: { label: 'The snooze', show: day },
  currentMileage: { label: 'The mileage', show: miles },
  registrationExpiration: { label: 'The registration date', show: day },
  inspectionExpiration: { label: 'The inspection date', show: day },
};

/** "The due date was changed after you marked it done, so it stays Mar 3." */
export const keptMessage = (kept: KeptField[], action: 'marked it done' | 'snoozed it' | 'renewed it' | 'updated it') => kept
  .filter(entry => KEPT_COPY[entry.field])
  .map(entry => {
    const copy = KEPT_COPY[entry.field];
    const shown = copy.show(entry.value);
    return shown
      ? `${copy.label} was changed after you ${action}, so it stays ${shown}.`
      : `${copy.label} was changed after you ${action}, so it stays as it is now.`;
  })
  .join(' ');

export const alreadyDoneMessage = (result: Extract<CompleteResult, { status: 'already_done' }>) => {
  const when = day(result.completedDate);
  return `Already done by ${result.byName || 'someone'}${when ? ` on ${when}` : ''}.`;
};

const REFUSALS: Record<CompletionRefusal, string> = {
  invalid_date: 'Enter a real completed date.',
  future_date: "The completed date can't be after today.",
  invalid_mileage: 'Enter the mileage as a whole number.',
  mileage_required: 'Enter the mileage so the next service can be scheduled.',
  next_due_required: 'Enter when it is next due, a date or a mileage.',
  invalid_next_due: 'Enter a real next due date or mileage.',
  next_due_mileage_low: 'The next due mileage must be higher than the completed mileage.',
};

export const refusalMessage = (reason: CompletionRefusal) => REFUSALS[reason] ?? "That wasn't saved.";

/** The field a refusal belongs to in the completion and log forms. */
export const refusalField = (reason: CompletionRefusal): 'completedDate' | 'mileage' | 'nextDueDate' | 'nextDueMileage' => {
  if (reason === 'invalid_date' || reason === 'future_date') return 'completedDate';
  if (reason === 'invalid_mileage' || reason === 'mileage_required') return 'mileage';
  if (reason === 'next_due_mileage_low') return 'nextDueMileage';
  return 'nextDueDate';
};

export const UNDO_HAS_ATTACHMENTS_MESSAGE = 'Remove the attached files first, or keep it done.';

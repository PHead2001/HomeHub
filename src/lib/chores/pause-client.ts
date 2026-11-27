/**
 * The client side of the away / sick pause (CH-32): calls the server action with the
 * signed-in user's ID token. Offline nothing is queued.
 */
import { pauseChores } from '@/app/chores/actions';
import { auth } from '@/lib/firebase';
import type { PauseOutcome } from './pause';

export { pauseMessage } from './pause';

export type PauseRequest = { memberUid: string; from: string; to: string; resume: boolean };

export type PauseResult = { ok: true; outcome: PauseOutcome } | { ok: false; message: string };

export async function pauseChoresOnServer(householdId: string, request: PauseRequest): Promise<PauseResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, message: "You're offline. Nothing was changed." };
  const user = auth.currentUser;
  if (!user) return { ok: false, message: 'Your sign-in has expired. Sign in again and retry.' };
  try {
    const result = await pauseChores({ idToken: await user.getIdToken(), householdId, ...request });
    if (result.ok) return { ok: true, outcome: result.data };
    return { ok: false, message: result.code === 'forbidden' ? "You can't pause chores here." : "Couldn't change the chores. Try again." };
  } catch {
    return { ok: false, message: "Couldn't change the chores. Try again." };
  }
}


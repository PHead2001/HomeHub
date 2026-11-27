/**
 * The client side of chore swaps (CH-31): the server actions with the signed-in
 * user's ID token. Offline nothing is queued.
 */
import { answerChoreSwap, offerChoreSwap } from '@/app/chores/actions';
import { auth } from '@/lib/firebase';
import type { AnswerOutcome, OfferOutcome } from './swap';

export { SWAP_REFUSED } from './swap';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

async function run<T>(task: (idToken: string) => Promise<{ ok: true; data: T } | { ok: false; code: string }>): Promise<Result<T>> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, message: "You're offline. Nothing was changed." };
  const user = auth.currentUser;
  if (!user) return { ok: false, message: 'Your sign-in has expired. Sign in again and retry.' };
  try {
    const result = await task(await user.getIdToken());
    if (result.ok) return result;
    return { ok: false, message: result.code === 'forbidden' ? "You can't swap chores here." : "Couldn't do that. Try again." };
  } catch {
    return { ok: false, message: "Couldn't do that. Try again." };
  }
}

export const offerSwapOnServer = (householdId: string, myChoreId: string, theirChoreId: string): Promise<Result<OfferOutcome>> =>
  run(idToken => offerChoreSwap({ idToken, householdId, myChoreId, theirChoreId }));

export const answerSwapOnServer = (householdId: string, offerId: string, answer: 'accept' | 'decline' | 'cancel'): Promise<Result<AnswerOutcome>> =>
  run(idToken => answerChoreSwap({ idToken, householdId, offerId, answer }));


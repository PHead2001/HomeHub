'use client';

/**
 * The one feed operation (audit PE-23, canonical for PE-1; PE-5; PE-2), bound
 * to the app's Firestore. Every feeding entry point goes through it: the Feed
 * button and hold to feed (`useQuickFeed`), the `?feed=1` picker, the command
 * palette's quick add (`logFeeding`), the palette's Feeding mode, the dashboard's
 * one-tap Fed and the feeding-log form (including backdated entries).
 *
 * The Firestore work is in `feed-transaction.ts` (`runFeed`, `runUndoFeed`,
 * `runCorrectFeedTime`, which take the Firestore instance); the pure planning is
 * in `feed-plan.ts`. Each press carries one operation id (`newFeedOpId`), reused
 * by "Feed again" and Retry, so it is recorded at most once (PE-23h), and a
 * "Feed again?" answer carries the state it was shown for (`feedConfirmOf`), so
 * a stale answer never bypasses a newer feed (PE-23g).
 */
import { db } from '@/lib/firebase';
import {
  runCorrectFeedTime,
  runFeed,
  runUndoFeed,
  type FeedPetInput,
  type FeedPetResult,
} from './feed-transaction';

export type { FeedPetInput, FeedPetResult } from './feed-transaction';
export { FeedCorrectionError } from './feed-transaction';

/** Logs a feeding, or returns `needsConfirm` so the UI can ask "Feed again?" (see `runFeed`). */
export function feedPet(input: FeedPetInput): Promise<FeedPetResult> {
  return runFeed(db, input);
}

/** Deletes a feeding (Undo and the history's delete), keeping the feeding state honest (see `runUndoFeed`). */
export function undoFeed(input: Parameters<typeof runUndoFeed>[1]): Promise<'saved' | 'queued'> {
  return runUndoFeed(db, input);
}

/** Corrects a saved feeding's effective time (PE-5e, see `runCorrectFeedTime`). */
export function correctFeedTime(input: Parameters<typeof runCorrectFeedTime>[1]): Promise<'saved'> {
  return runCorrectFeedTime(db, input);
}

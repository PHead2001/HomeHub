/**
 * The Pets module's live Firestore listener (PE-8g): a `resilientListener` (the
 * HP-5 pattern of the dashboard) for snapshots, where only an answer confirmed
 * by the server (`!snapshot.metadata.fromCache`) counts as recovered. A cached
 * snapshot, which Firestore serves from the persistent cache before each
 * refused read, therefore never resets the backoff or the permission-denied
 * count, so a member who lost access settles on `unauthorized` instead of
 * resubscribing forever. Subscribe with `includeMetadataChanges: true`, so a
 * cached answer that turns into a server answer is seen.
 *
 * Framework-free (the subscribe function is injected) and unit tested.
 */
import {
  resilientListener,
  type ListenerStatus,
  type ResilientEnvironment,
  type ResilientHandle,
} from '../dashboard/resilient-listener';

export function petSnapshotListener<T extends { metadata: { fromCache: boolean } }>(
  subscribe: (next: (value: T) => void, error: (error: unknown) => void) => () => void,
  handlers: { next: (value: T) => void; status?: (status: ListenerStatus) => void },
  environment?: ResilientEnvironment,
): ResilientHandle {
  return resilientListener<T>(subscribe, { ...handlers, confirmed: (snapshot) => !snapshot.metadata.fromCache }, environment);
}

/* ------------------------------------------------------------------------- */
/* What a live view holds when its listener fails (PE-8g, PE-18c)             */
/* ------------------------------------------------------------------------- */

/** `retrying`: resubscribing on its own; `unauthorized`: access was refused (no retry offered). */
export type LiveFailure = false | 'retrying' | 'unauthorized';

/** A live value keyed by what it belongs to (household/pet), so another key's data never shows. */
export type LiveState<T> = { key: string | null; value: T | null; loaded: boolean; failed: LiveFailure };

/** A server or cache answer: the value, with no failure. */
export function liveAnswer<T>(key: string | null, value: T | null): LiveState<T> {
  return { key, value, loaded: true, failed: false };
}

/**
 * A listener failure. Content already loaded for the same key stays on screen,
 * but the failure is recorded, so the view says it is reconnecting or that
 * access changed; with nothing loaded the failure is the whole state.
 */
export function liveFailure<T>(previous: LiveState<T>, key: string | null, kind: Exclude<LiveFailure, false>): LiveState<T> {
  if (previous.key === key && previous.loaded) return { ...previous, failed: kind };
  return { key, value: null, loaded: false, failed: kind };
}

/** The notice shown beside retained content: null when live, or when nothing was loaded (the view shows its failure state). */
export function liveNotice(state: Pick<LiveState<unknown>, 'loaded' | 'failed'>): 'reconnecting' | 'access-changed' | null {
  if (!state.loaded || !state.failed) return null;
  return state.failed === 'unauthorized' ? 'access-changed' : 'reconnecting';
}

/** "Your access to pets changed. This is the last version of this pet that loaded." / "Reconnecting…" */
export function staleNoticeText(notice: 'reconnecting' | 'access-changed', subject: string): string {
  return notice === 'access-changed'
    ? `Your access to pets changed. This is the last version of ${subject} that loaded.`
    : `Reconnecting… changes by others will show again once ${subject} is back.`;
}

/** A history that could not be read: honest about a refusal (no retry) versus a reconnect. */
export function unavailableText(subject: string, failure: LiveFailure): string {
  return failure === 'unauthorized'
    ? `${subject} isn't available to you: your access to pets changed.`
    : `${subject} is unavailable right now. Reconnecting…`;
}

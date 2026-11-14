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

/**
 * The identity of a Pets listener: what it reads (`scope`, e.g. household and
 * pet) and who reads it (the member's uid and whether they hold `pets.view`).
 * Listeners are keyed on it, so when access returns (pets.view granted again)
 * or another member signs in, a listener that settled on `unauthorized` is
 * recreated instead of staying refused until a reload. Null without a scope.
 */
export function petListenerKey(scope: string | null, access: { uid?: string | null; canView: boolean }): string | null {
  if (!scope) return null;
  return `${scope}|${access.uid ?? ''}|${access.canView ? 'view' : 'no-view'}`;
}

/* ------------------------------------------------------------------------- */
/* A settled access key (no second subscription while membership settles)     */
/* ------------------------------------------------------------------------- */

/** Who reads a Pets listener: the member and whether they hold `pets.view`. */
export type PetAccess = { uid: string | null; canView: boolean };

/**
 * The access Pets listeners are keyed on, given the one kept so far, the
 * current one and whether auth and household membership have settled
 * (neither is loading). Before the first settle there is none (null: no
 * listener starts, readers show loading), so a key that would change once
 * after the first render (permissions arriving with the membership) never
 * subscribes twice or drops a loaded view back to a skeleton. While a later
 * membership snapshot is loading (a transient empty member), the kept access
 * stays. Once settled, a real change (pets.view granted or revoked, another
 * member) is taken, so the listener is recreated, as `petListenerKey` intends.
 */
export function settledPetAccess(kept: PetAccess | null, current: PetAccess, settled: boolean): PetAccess | null {
  if (!settled) return kept;
  if (kept && kept.uid === current.uid && kept.canView === current.canView) return kept;
  return { uid: current.uid, canView: current.canView };
}

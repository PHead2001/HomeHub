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

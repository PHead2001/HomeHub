// R1 / JC-17 (docs/modules/devices/README.md, "Device actions: chores"). Pure: shared by the
// server's Undo check and the unit tests.

/** R1 / JC-17: a queued Undo must have been made on the tablet within this long of the action it reverses. */
export const QUEUED_UNDO_DEVICE_GAP_MS = 15_000;

/**
 * Whether a queued Undo was made soon enough after its queued action, both times on the
 * same device clock (JC-17). The server cannot verify that a request really came from the
 * tablet's queue, so the longer window also needs this, and the server's own `appliedAt`
 * bound still applies.
 */
export const queuedUndoInTime = (actionCreatedAt: string | null, undoCreatedAt: string | null | undefined): boolean => {
  if (!actionCreatedAt || !undoCreatedAt) return false;
  const gap = Date.parse(undoCreatedAt) - Date.parse(actionCreatedAt);
  return Number.isFinite(gap) && gap >= 0 && gap <= QUEUED_UNDO_DEVICE_GAP_MS;
};


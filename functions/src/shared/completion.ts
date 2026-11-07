// When a chore was completed: the one rule shared by the web app (Chores,
// dashboard, Home Wrapped) and the server (yearly stats on retention). Pure.

type TimestampLike = {toDate: () => Date} |
  {seconds: number; nanoseconds?: number};

export type CompletionFields = {
  isCompleted?: unknown;
  completedAt?: unknown;
  completedAtServer?: unknown;
};

const fromTimestampLike = (value: unknown): Date | null => {
  if (!value || typeof value !== "object") return null;
  const stamp = value as Partial<TimestampLike> & Record<string, unknown>;
  if (typeof stamp.toDate === "function") {
    const date = (stamp as {toDate: () => Date}).toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  if (typeof stamp.seconds === "number") {
    return new Date(stamp.seconds * 1000);
  }
  return null;
};

/**
 * The authoritative completion instant: the server stamp
 * `completedAtServer` when present (rules pin it to the request time), else
 * the client-written `completedAt` ISO string. Null when not completed.
 * @param {CompletionFields} chore Chore fields.
 * @return {Date | null} Completion instant.
 */
export const choreCompletionInstant = (
  chore: CompletionFields,
): Date | null => {
  if (chore.isCompleted !== true) return null;
  const server = fromTimestampLike(chore.completedAtServer);
  if (server) return server;
  if (typeof chore.completedAt !== "string" || !chore.completedAt) {
    return null;
  }
  const parsed = new Date(chore.completedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

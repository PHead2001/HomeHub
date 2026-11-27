/**
 * Photo proof for kids (CH-30). A library chore with `requiresPhoto: true` cannot be
 * completed by a child account (or a kid profile on a tablet) directly: the kid sends
 * a photo, the chore is "pending" (still open, no points), and a member who may edit
 * chores approves it, which completes it credited to the kid at the time the photo
 * was sent (so an on-time chore stays on time), or sends it back. Pure, shared by the
 * server operations, the page and the tests.
 */
import type { ChoreRecord } from './dates';

/** Storage folder of a chore's proof photos: `households/{h}/chore-proofs/{choreId}/{uid}-{random}.{ext}`. */
export const PROOF_FOLDER = 'chore-proofs';

/** Largest photo accepted (Storage rules too). */
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export type ProofStatus = 'pending' | 'rejected';

/** The proof on a chore (server-written; clients may not set, change or remove it). */
export type ChoreProof = {
  status: ProofStatus;
  photoPath: string | null;
  submittedByUid: string;
  submittedByName: string;
  /** When the kid sent it (ISO); an approval completes the chore at this instant. */
  submittedAt: string;
  reviewedByUid?: string;
  reviewedByName?: string;
};

/** Whether this member must send a photo for a chore of this library chore: kids, when it asks for one. */
export function needsPhotoProof(role: unknown, template: { requiresPhoto?: unknown } | null | undefined): boolean {
  return role === 'child' && template?.requiresPhoto === true;
}

const SEGMENT = /^[A-Za-z0-9_.|-]{1,1500}$/;
const FILE = /^[A-Za-z0-9_-]{1,128}-[A-Za-z0-9]{6,40}\.(jpg|jpeg|png|webp|heic|heif)$/;

/** The object path a kid uploads to; the file name starts with their uid. */
export function proofPath(householdId: string, choreId: string, uid: string, random: string, extension = 'jpg'): string {
  return `households/${householdId}/${PROOF_FOLDER}/${choreId}/${uid}-${random}.${extension}`;
}

/** Whether `path` is a proof photo of this chore uploaded by `uid` (the server checks this before trusting it). */
export function isProofPathFor(path: unknown, householdId: string, choreId: string, uid: string): path is string {
  if (typeof path !== 'string' || path.length > 2000) return false;
  const prefix = `households/${householdId}/${PROOF_FOLDER}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return false;
  const folder = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  return folder === choreId && SEGMENT.test(folder) && FILE.test(file) && file.startsWith(`${uid}-`);
}

/** The proof stored on a chore, or null. */
export function readProof(value: unknown): ChoreProof | null {
  if (!value || typeof value !== 'object') return null;
  const proof = value as Record<string, unknown>;
  if (proof.status !== 'pending' && proof.status !== 'rejected') return null;
  if (typeof proof.submittedByUid !== 'string' || typeof proof.submittedAt !== 'string') return null;
  return {
    status: proof.status,
    photoPath: typeof proof.photoPath === 'string' ? proof.photoPath : null,
    submittedByUid: proof.submittedByUid,
    submittedByName: typeof proof.submittedByName === 'string' ? proof.submittedByName : '',
    submittedAt: proof.submittedAt,
    ...(typeof proof.reviewedByUid === 'string' ? { reviewedByUid: proof.reviewedByUid } : {}),
    ...(typeof proof.reviewedByName === 'string' ? { reviewedByName: proof.reviewedByName } : {}),
  };
}

/** Open chores with a photo waiting for approval, oldest first. */
export function pendingProofs<T extends Pick<ChoreRecord, 'isCompleted'> & { proof?: unknown }>(chores: readonly T[]): T[] {
  return chores
    .filter(chore => !chore.isCompleted && readProof(chore.proof)?.status === 'pending')
    .sort((a, b) => readProof(a.proof)!.submittedAt.localeCompare(readProof(b.proof)!.submittedAt));
}

export type SubmitOutcome =
  | { choreId: string; status: 'pending' }
  | { choreId: string; status: 'refused'; refused: 'missing' | 'completed' | 'early' | 'not-required' | 'photo-missing' | 'already-pending' };

export type ReviewOutcome =
  | { choreId: string; status: 'approved' | 'sent-back' }
  | { choreId: string; status: 'refused'; refused: 'missing' | 'not-pending' | 'own-photo' | 'forbidden' };

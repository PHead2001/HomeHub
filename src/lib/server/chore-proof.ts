import 'server-only';

import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { safeTimeZone } from '@functions/shared/calendar';
import { isDocId } from '@functions/shared/push-media';
import { completionEligibility, isChoreDocId, stringList } from '@/lib/chores/completion';
import { MAX_PROOF_BYTES, isProofPathFor, needsPhotoProof, readProof, type ReviewOutcome, type SubmitOutcome } from '@/lib/chores/proof';
import { publicDisplayName } from '@/lib/member-directory';
import { getMemberPermissions } from '@/lib/permissions';
import type { HouseholdMember, HouseholdPermission } from '@/lib/types';

/**
 * Photo proof for kids (CH-30) through the Admin SDK. Submitting needs `chores.complete`
 * (the server action) and a child role; the photo must already be in Storage under this
 * chore's folder, named for the caller, an image no bigger than 5 MB, with the caller as
 * `uploadedByUid` (the Storage rules require the same on upload). The chore stays open
 * with `proof.status: 'pending'`: no points. Reviewing needs `chores.edit` and is never
 * by the person who sent the photo: approving completes the chore in one transaction,
 * credited to the kid at the instant they sent it; sending it back leaves it open
 * (`proof.status: 'rejected'`). Either way the photo is then deleted (best effort):
 * it is only kept while someone has to look at it.
 */

export class ChoreProofError extends Error {
  constructor(readonly code: 'invalid' | 'not-found') {
    super(code);
    this.name = 'ChoreProofError';
  }
}

/** The part of a Storage bucket these operations use (the Admin SDK bucket, or a test double). */
export type ProofBucket = {
  file(path: string): {
    exists(): Promise<[boolean]>;
    getMetadata(): Promise<[{ contentType?: string; size?: number | string; metadata?: Record<string, unknown> | null }]>;
    delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  };
};

const IMAGE = /^image\/(png|jpeg|webp|gif|heic|heif|avif)$/;

const houseOf = (db: Firestore, householdId: string) => {
  if (!isDocId(householdId)) throw new ChoreProofError('invalid');
  return db.collection('households').doc(householdId);
};

const choreIdOf = (value: unknown): string => {
  if (!isChoreDocId(value)) throw new ChoreProofError('invalid');
  return value;
};

/** The photo is there, is an image within the limit, and the caller uploaded it. */
async function photoIsTheirs(bucket: ProofBucket | null, path: string, uid: string): Promise<boolean> {
  if (!bucket) return false;
  try {
    const file = bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) return false;
    const [meta] = await file.getMetadata();
    const size = Number(meta.size ?? NaN);
    return IMAGE.test(meta.contentType ?? '') && Number.isFinite(size) && size > 0 && size <= MAX_PROOF_BYTES
      && meta.metadata?.uploadedByUid === uid;
  } catch {
    return false;
  }
}

export async function submitChoreProofAs(
  db: Firestore,
  bucket: ProofBucket | null,
  householdId: string,
  caller: { uid: string; displayName?: string },
  input: { choreId?: unknown; photoPath?: unknown },
  now: Date,
): Promise<SubmitOutcome> {
  const house = houseOf(db, householdId);
  const choreId = choreIdOf(input?.choreId);
  if (!isProofPathFor(input.photoPath, householdId, choreId, caller.uid)) throw new ChoreProofError('invalid');
  const photoPath = input.photoPath;
  if (!(await photoIsTheirs(bucket, photoPath, caller.uid))) return { choreId, status: 'refused', refused: 'photo-missing' };
  return db.runTransaction(async tx => {
    const [home, member, chore] = await tx.getAll(house, house.collection('members').doc(caller.uid), house.collection('chores').doc(choreId));
    if (!home.exists || home.get('deletingAt')) throw new ChoreProofError('not-found');
    if (!chore.exists) return { choreId, status: 'refused', refused: 'missing' };
    if (chore.get('isCompleted') === true) return { choreId, status: 'refused', refused: 'completed' };
    const templateId = chore.get('templateId');
    const template = typeof templateId === 'string' && isDocId(templateId) ? await tx.get(house.collection('chore-templates').doc(templateId)) : null;
    if (!needsPhotoProof(member.get('role'), template?.exists ? template.data() : null)) return { choreId, status: 'refused', refused: 'not-required' };
    if (completionEligibility(chore.data()!, now, safeTimeZone(home.get('timeZone'))) === 'early') return { choreId, status: 'refused', refused: 'early' };
    if (readProof(chore.get('proof'))?.status === 'pending') return { choreId, status: 'refused', refused: 'already-pending' };
    tx.update(chore.ref, {
      proof: {
        status: 'pending',
        photoPath,
        submittedByUid: caller.uid,
        // Shown to every member: a name, never an email.
        submittedByName: publicDisplayName(member.get('displayName'), '') || publicDisplayName(caller.displayName),
        submittedAt: now.toISOString(),
        submittedAtServer: FieldValue.serverTimestamp(),
      },
    });
    return { choreId, status: 'pending' };
  });
}

export async function reviewChoreProofAs(
  db: Firestore,
  bucket: ProofBucket | null,
  householdId: string,
  caller: { uid: string; displayName?: string },
  input: { choreId?: unknown; approve?: unknown },
): Promise<ReviewOutcome> {
  const house = houseOf(db, householdId);
  const choreId = choreIdOf(input?.choreId);
  const approve = input.approve === true;
  let photoPath: string | null = null;
  const outcome = await db.runTransaction(async (tx): Promise<ReviewOutcome> => {
    const [home, reviewer, chore] = await tx.getAll(house, house.collection('members').doc(caller.uid), house.collection('chores').doc(choreId));
    if (!home.exists || home.get('deletingAt')) throw new ChoreProofError('not-found');
    const permissions: Partial<Record<HouseholdPermission, boolean>> = reviewer.exists ? getMemberPermissions(reviewer.data() as HouseholdMember) : {};
    if (!permissions['chores.edit']) return { choreId, status: 'refused', refused: 'forbidden' };
    if (!chore.exists) return { choreId, status: 'refused', refused: 'missing' };
    const proof = readProof(chore.get('proof'));
    if (chore.get('isCompleted') === true || proof?.status !== 'pending') return { choreId, status: 'refused', refused: 'not-pending' };
    if (proof.submittedByUid === caller.uid) return { choreId, status: 'refused', refused: 'own-photo' };
    photoPath = proof.photoPath;
    const reviewedByName = publicDisplayName(reviewer.get('displayName'), '') || publicDisplayName(caller.displayName);
    if (!approve) {
      tx.update(chore.ref, { proof: { ...proof, status: 'rejected', photoPath: null, reviewedByUid: caller.uid, reviewedByName } });
      return { choreId, status: 'sent-back' };
    }
    const submitted = new Date(proof.submittedAt);
    const steps = stringList(chore.get('subTasks')) ?? [];
    // The approval awards the points: the kid completed it when they sent the photo.
    tx.update(chore.ref, {
      isCompleted: true,
      completedAt: proof.submittedAt,
      completedAtServer: chore.get('proof.submittedAtServer') instanceof Timestamp ? chore.get('proof.submittedAtServer') : Timestamp.fromDate(submitted),
      completedByUid: proof.submittedByUid,
      completedByName: proof.submittedByName,
      completedByEmail: FieldValue.delete(),
      completionId: randomUUID(),
      ...(steps.length > 0 ? { completedSubTasks: steps } : {}),
      deviceAttribution: FieldValue.delete(),
      proof: FieldValue.delete(),
    });
    return { choreId, status: 'approved' };
  });
  if (outcome.status !== 'refused' && photoPath && bucket) {
    await bucket.file(photoPath).delete({ ignoreNotFound: true }).catch(() => undefined);
  }
  return outcome;
}

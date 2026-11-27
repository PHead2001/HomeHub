import 'server-only';

import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { isDocId } from '@functions/shared/push-media';
import { isChoreDocId } from '@/lib/chores/completion';
import { MAX_PENDING_SWAPS, SWAP_TTL_MS, readSwapOffer, type AnswerOutcome, type OfferOutcome } from '@/lib/chores/swap';
import { buildNotificationDocument } from '@/lib/notifications';
import { publicDisplayName } from '@/lib/member-directory';

/**
 * Chore swaps (CH-31) through the Admin SDK. The server action requires
 * `chores.complete`. An offer names one open chore assigned (by uid) to the caller and
 * one open chore assigned to another member with an approved account (never a kid
 * profile, a pending or a departed member); a sender has at most `MAX_PENDING_SWAPS`
 * open offers (pending and not expired) at a time. It is stored in
 * `chore-swaps` and the other member gets a notification with a deep link (no push
 * actions). Only that member accepts or declines, only the offerer cancels; accepting
 * swaps the two assignees in one transaction while both chores are still open and still
 * assigned as offered and the offer is pending and not expired. Each answer notifies the
 * offerer. Nobody's points change: completion credits whoever completes.
 */

export class ChoreSwapError extends Error {
  constructor(readonly code: 'invalid' | 'not-found') {
    super(code);
    this.name = 'ChoreSwapError';
  }
}

const houseOf = (db: Firestore, householdId: string) => {
  if (!isDocId(householdId)) throw new ChoreSwapError('invalid');
  return db.collection('households').doc(householdId);
};

const choreIdOf = (value: unknown) => {
  if (!isChoreDocId(value)) throw new ChoreSwapError('invalid');
  return value;
};

const nameOf = (snap: { get(field: string): unknown }) => publicDisplayName(snap.get('displayName'));
const isActive = (snap: { exists: boolean; get(field: string): unknown }) => snap.exists && (snap.get('status') ?? 'active') === 'active'
  && ['owner', 'admin', 'member', 'child'].includes(String(snap.get('role')));

const notify = (tx: Transaction, house: DocumentReference, householdId: string, targetUid: string, title: string, message: string, offerId: string, state: string) => {
  tx.set(house.collection('notifications').doc(), buildNotificationDocument({
    householdId, category: 'chores', title, message, deepLink: `/chores?swap=${offerId}`,
    sourceType: 'chore-swap', sourceId: offerId, stateKey: state, targetUser: { uid: targetUid },
  }));
};

export async function offerSwapAs(
  db: Firestore,
  householdId: string,
  caller: { uid: string },
  input: { myChoreId?: unknown; theirChoreId?: unknown },
  now: Date,
): Promise<OfferOutcome> {
  const house = houseOf(db, householdId);
  const myChoreId = choreIdOf(input?.myChoreId);
  const theirChoreId = choreIdOf(input?.theirChoreId);
  if (myChoreId === theirChoreId) throw new ChoreSwapError('invalid');
  return db.runTransaction(async (tx): Promise<OfferOutcome> => {
    const [home, me, mine, theirs] = await tx.getAll(house, house.collection('members').doc(caller.uid), house.collection('chores').doc(myChoreId), house.collection('chores').doc(theirChoreId));
    if (!home.exists || home.get('deletingAt')) throw new ChoreSwapError('not-found');
    if (!isActive(me) || me.get('kind') === 'identity') return { status: 'refused', refused: 'not-member' };
    if (!mine.exists || !theirs.exists) return { status: 'refused', refused: 'missing' };
    if (mine.get('isCompleted') === true || theirs.get('isCompleted') === true) return { status: 'refused', refused: 'done' };
    if (mine.get('assignedToUid') !== caller.uid) return { status: 'refused', refused: 'not-yours' };
    const toUid = theirs.get('assignedToUid');
    if (typeof toUid !== 'string' || !toUid) return { status: 'refused', refused: 'not-theirs' };
    if (toUid === caller.uid) return { status: 'refused', refused: 'same-person' };
    // Kid profiles have no account to answer with.
    if (toUid.startsWith('kid_') || !isDocId(toUid)) return { status: 'refused', refused: 'kid-profile' };
    const [them, pending] = await Promise.all([
      tx.get(house.collection('members').doc(toUid)),
      tx.get(house.collection('chore-swaps').where('fromUid', '==', caller.uid).where('status', '==', 'pending')),
    ]);
    // Only someone with an approved account can answer.
    if (!isActive(them) || them.get('kind') === 'identity') return { status: 'refused', refused: 'not-member' };
    // A cap on open offers, so nobody can flood a housemate's notifications.
    const open = pending.docs.filter(doc => String(doc.get('expiresAt') ?? '') > now.toISOString()).length;
    if (open >= MAX_PENDING_SWAPS) return { status: 'refused', refused: 'too-many' };
    const offerRef = house.collection('chore-swaps').doc();
    const fromName = nameOf(me);
    const fromTask = String(mine.get('task') ?? '');
    const toTask = String(theirs.get('task') ?? '');
    tx.set(offerRef, {
      fromUid: caller.uid, fromName, toUid, toName: nameOf(them),
      fromChoreId: myChoreId, fromTask, toChoreId: theirChoreId, toTask,
      status: 'pending', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SWAP_TTL_MS).toISOString(),
      createdAtServer: FieldValue.serverTimestamp(),
    });
    notify(tx, house, householdId, toUid, 'Swap a chore?', `${fromName} offers to do ${toTask} if you do ${fromTask}.`, offerRef.id, 'offered');
    return { status: 'offered', offerId: offerRef.id };
  });
}

export async function answerSwapAs(
  db: Firestore,
  householdId: string,
  caller: { uid: string },
  input: { offerId?: unknown; answer?: unknown },
  now: Date,
): Promise<AnswerOutcome> {
  const house = houseOf(db, householdId);
  const offerId = input?.offerId;
  if (typeof offerId !== 'string' || !isDocId(offerId)) throw new ChoreSwapError('invalid');
  const answer = input.answer;
  if (answer !== 'accept' && answer !== 'decline' && answer !== 'cancel') throw new ChoreSwapError('invalid');
  return db.runTransaction(async (tx): Promise<AnswerOutcome> => {
    const offerRef = house.collection('chore-swaps').doc(offerId);
    const [home, offerSnap, caller_] = await tx.getAll(house, offerRef, house.collection('members').doc(caller.uid));
    if (!home.exists || home.get('deletingAt')) throw new ChoreSwapError('not-found');
    const offer = offerSnap.exists ? readSwapOffer(offerSnap.data()) : null;
    if (!offer) return { status: 'refused', refused: 'missing' };
    if (answer === 'cancel' ? offer.fromUid !== caller.uid : offer.toUid !== caller.uid) return { status: 'refused', refused: 'not-for-you' };
    if (offer.status !== 'pending') return { status: 'refused', refused: 'answered' };
    const answeredAt = now.toISOString();
    const callerName = nameOf(caller_);
    if (answer === 'cancel') {
      tx.update(offerRef, { status: 'cancelled', answeredAt });
      return { status: 'cancelled' };
    }
    if (answer === 'decline') {
      tx.update(offerRef, { status: 'declined', answeredAt });
      notify(tx, house, householdId, offer.fromUid, 'Swap declined', `${callerName} kept ${offer.toTask}. You still have ${offer.fromTask}.`, offerId, 'declined');
      return { status: 'declined' };
    }
    if (answeredAt > offer.expiresAt) return { status: 'refused', refused: 'expired' };
    const [mine, theirs, from] = await tx.getAll(house.collection('chores').doc(offer.fromChoreId), house.collection('chores').doc(offer.toChoreId), house.collection('members').doc(offer.fromUid));
    const intact = mine.exists && theirs.exists && mine.get('isCompleted') !== true && theirs.get('isCompleted') !== true
      && mine.get('assignedToUid') === offer.fromUid && theirs.get('assignedToUid') === offer.toUid && isActive(from);
    if (!intact) return { status: 'refused', refused: 'changed' };
    tx.update(mine.ref, { assignedToUid: offer.toUid, assignedToDisplayName: callerName, assignedToEmail: FieldValue.delete() });
    tx.update(theirs.ref, { assignedToUid: offer.fromUid, assignedToDisplayName: nameOf(from), assignedToEmail: FieldValue.delete() });
    tx.update(offerRef, { status: 'accepted', answeredAt });
    notify(tx, house, householdId, offer.fromUid, 'Swap accepted', `${callerName} does ${offer.fromTask} and you do ${offer.toTask}.`, offerId, 'accepted');
    return { status: 'accepted' };
  });
}

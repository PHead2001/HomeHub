/**
 * Up for grabs and swaps (CH-31). Pure, shared by the server operations, the page and
 * the tests.
 *
 * - Up for grabs: a one-time chore for "Anyone" has no assignee; whoever does it
 *   completes it and gets the points (D-7, the completion already credits the completer).
 * - Swaps: a member offers one of their open chores for one of a housemate's open
 *   chores; the housemate gets a notification linking to `/chores?swap=<offerId>` and
 *   accepts or declines. The server swaps the two assignees only while both chores are
 *   still open and still assigned as offered, and the offer is pending and not expired.
 */
import type { ChoreRecord } from './dates';

/** The Add Chore "Who" value for a chore anyone may do. */
export const ANYONE = '__anyone__';

/** Most open (pending, not expired) offers one person may have at a time. */
export const MAX_PENDING_SWAPS = 5;

/** How long an offer stays open. */
export const SWAP_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export type SwapStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

/** `households/{h}/chore-swaps/{offerId}`, written only by the server. */
export type SwapOffer = {
  fromUid: string;
  fromName: string;
  toUid: string;
  toName: string;
  fromChoreId: string;
  fromTask: string;
  toChoreId: string;
  toTask: string;
  status: SwapStatus;
  createdAt: string;
  expiresAt: string;
  answeredAt?: string;
};

/** A chore nobody is assigned to (no uid and no older email): up for grabs. */
export function isUpForGrabs(chore: Pick<ChoreRecord, 'assignedToUid' | 'assignedToEmail'>): boolean {
  const uid = typeof chore.assignedToUid === 'string' ? chore.assignedToUid.trim() : '';
  const email = typeof chore.assignedToEmail === 'string' ? chore.assignedToEmail.trim() : '';
  return !uid && !email;
}

/** Whether `uid` may offer this chore in a swap: open and assigned to them by uid. */
export function maySwapAway(chore: Pick<ChoreRecord, 'isCompleted' | 'assignedToUid'>, uid: string): boolean {
  return !chore.isCompleted && chore.assignedToUid === uid && uid !== '';
}

/** The housemates' open chores `uid` could ask for: assigned by uid to someone else with an account (not a kid profile), soonest first. */
export function swapTargets<T extends Pick<ChoreRecord, 'id' | 'isCompleted' | 'assignedToUid' | 'originalDueDate' | 'task'>>(chores: readonly T[], uid: string): T[] {
  return chores
    .filter(chore => !chore.isCompleted && typeof chore.assignedToUid === 'string' && chore.assignedToUid !== '' && chore.assignedToUid !== uid && !chore.assignedToUid.startsWith('kid_'))
    .sort((a, b) => (a.originalDueDate || '').localeCompare(b.originalDueDate || '') || a.task.localeCompare(b.task));
}

/** Reads a stored offer, or null. */
export function readSwapOffer(value: unknown): SwapOffer | null {
  if (!value || typeof value !== 'object') return null;
  const offer = value as Record<string, unknown>;
  const text = (key: string) => (typeof offer[key] === 'string' ? offer[key] as string : null);
  const status = text('status');
  if (!status || !['pending', 'accepted', 'declined', 'cancelled'].includes(status)) return null;
  const required = ['fromUid', 'toUid', 'fromChoreId', 'toChoreId', 'createdAt', 'expiresAt'].map(text);
  if (required.some(value => !value)) return null;
  return {
    fromUid: text('fromUid')!, fromName: text('fromName') ?? '', toUid: text('toUid')!, toName: text('toName') ?? '',
    fromChoreId: text('fromChoreId')!, fromTask: text('fromTask') ?? '', toChoreId: text('toChoreId')!, toTask: text('toTask') ?? '',
    status: status as SwapStatus, createdAt: text('createdAt')!, expiresAt: text('expiresAt')!,
    ...(text('answeredAt') ? { answeredAt: text('answeredAt')! } : {}),
  };
}

export type OfferOutcome = { status: 'offered'; offerId: string } | { status: 'refused'; refused: 'missing' | 'not-yours' | 'not-theirs' | 'same-person' | 'kid-profile' | 'done' | 'not-member' | 'too-many' };
export type AnswerOutcome = { status: 'accepted' | 'declined' | 'cancelled' } | { status: 'refused'; refused: 'missing' | 'not-for-you' | 'answered' | 'expired' | 'changed' };

/** Plain words for every refusal. */
export const SWAP_REFUSED: Record<string, string> = {
  missing: 'One of those chores is gone.',
  'not-yours': 'You can only offer a chore that is yours.',
  'not-theirs': 'That chore is not assigned to someone who can answer.',
  'same-person': 'Both chores are already yours.',
  'kid-profile': 'Kid profiles cannot answer swaps.',
  'not-member': 'Swaps are only between members with an approved account.',
  'too-many': `You already have ${MAX_PENDING_SWAPS} swap offers waiting. Wait for an answer or withdraw one first.`,
  done: 'One of those chores is already done.',
  'not-for-you': 'This swap is not yours to answer.',
  answered: 'This swap was already answered.',
  expired: 'This swap offer has expired.',
  changed: 'One of the chores changed since, so the swap was not made.',
};

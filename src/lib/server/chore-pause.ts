import 'server-only';

import type { Firestore } from 'firebase-admin/firestore';
import { safeTimeZone } from '@functions/shared/calendar';
import { storedOccurrenceKey } from '@functions/shared/ids';
import { withSkippedOccurrences } from '@functions/shared/skips';
import { isDocId } from '@functions/shared/push-media';
import { householdToday } from '@/lib/chores/completion';
import { checkPauseRange, pauseFits, pauseKeys, withoutSkippedOccurrences, type PauseOutcome, type PauseTemplate } from '@/lib/chores/pause';
import { getMemberPermissions } from '@/lib/permissions';
import type { HouseholdMember, HouseholdPermission } from '@/lib/types';

/**
 * Away / sick pause (CH-32) through the Admin SDK. The caller is whoever the ID token
 * proved (the server action requires `chores.edit`): a member pauses their own chores;
 * pausing someone else's also needs `chores.delete` (it deletes their days, like
 * deleting days does), checked here against the stored member record. One transaction:
 * every template of the member's repeating chores records the range's occurrence keys
 * as skipped and the open generated days in the range that are still assigned to that
 * member are deleted, so nothing comes back. A day already swapped or reassigned to
 * someone else is left alone (and not skipped), and completed days are never touched.
 * Resume removes those keys; upkeep then generates the days again from today.
 */

export type PauseInput = { memberUid?: unknown; from?: unknown; to?: unknown; resume?: unknown };

export type { PauseOutcome } from '@/lib/chores/pause';

export class ChorePauseError extends Error {
  constructor(readonly code: 'invalid' | 'not-found') {
    super(code);
    this.name = 'ChorePauseError';
  }
}

export async function pauseChoresAs(db: Firestore, householdId: string, caller: { uid: string }, input: PauseInput, now: Date): Promise<PauseOutcome> {
  if (!isDocId(householdId)) throw new ChorePauseError('invalid');
  const memberUid = input?.memberUid;
  if (typeof memberUid !== 'string' || !isDocId(memberUid)) throw new ChorePauseError('invalid');
  const resume = input.resume === true;
  const house = db.collection('households').doc(householdId);
  return db.runTransaction(async tx => {
    const [home, callerSnap, targetSnap] = await tx.getAll(house, house.collection('members').doc(caller.uid), house.collection('members').doc(memberUid));
    if (!home.exists || home.get('deletingAt')) throw new ChorePauseError('not-found');
    const permissions: Partial<Record<HouseholdPermission, boolean>> = callerSnap.exists ? getMemberPermissions(callerSnap.data() as HouseholdMember) : {};
    if (!permissions['chores.edit']) return { status: 'refused', reason: 'forbidden' };
    // Someone else's chores: pausing deletes their days, the same right as deleting days.
    if (memberUid !== caller.uid && !permissions['chores.delete']) return { status: 'refused', reason: 'forbidden' };
    const target = targetSnap.exists ? targetSnap.data() as HouseholdMember : null;
    if (!target || (target.status ?? 'active') !== 'active') return { status: 'refused', reason: 'not-member' };

    const timeZone = safeTimeZone(home.get('timeZone'));
    const today = householdToday(now, timeZone);
    const checked = checkPauseRange({ from: input.from, to: input.to }, today);
    if (!checked.ok) return { status: 'refused', reason: checked.reason };

    const [templatesSnap, membersSnap] = await Promise.all([tx.get(house.collection('chore-templates')), tx.get(house.collection('members'))]);
    // Who can take a rotation turn (CH-28), as upkeep judges it: active members, not kid profiles.
    const eligibleUids = new Set(membersSnap.docs.filter(doc => (doc.get('status') ?? 'active') === 'active' && doc.get('kind') !== 'identity'
      && ['owner', 'admin', 'member', 'child'].includes(String(doc.get('role')))).map(doc => doc.id));
    const templates: PauseTemplate[] = templatesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    // Assignees are uids since member privacy release C; an older template still
    // carrying only an email is matched by uid alone here (its uid is written beside it).
    const found = pauseKeys(templates, memberUid, [{ uid: memberUid }], checked.range, today, uid => eligibleUids.has(uid));
    const byId = new Map(templatesSnap.docs.map(doc => [doc.id, doc]));
    // Open generated days, by occurrence key. A day of the series that is now someone
    // else's (swapped or reassigned) stays theirs: it is neither deleted nor skipped.
    const open = await tx.get(house.collection('chores').where('isCompleted', '==', false));
    const openByKey = new Map(open.docs.flatMap(doc => {
      const key = storedOccurrenceKey(doc.id, doc.data());
      return key ? [[key, doc] as const] : [];
    }));
    const someoneElses = (key: string) => {
      const day = openByKey.get(key);
      return day !== undefined && day.get('assignedToUid') !== memberUid;
    };
    const keys = new Map([...found].map(([templateId, list]) => [templateId, list.filter(key => !someoneElses(key))] as const).filter(([, list]) => list.length > 0));
    const days = new Set([...keys.values()].flat().map(key => key.slice(key.lastIndexOf('|') + 1))).size;

    if (resume) {
      for (const [templateId, add] of keys) {
        const snap = byId.get(templateId)!;
        tx.update(snap.ref, { skippedOccurrences: withoutSkippedOccurrences(snap.get('skippedOccurrences'), add) });
      }
      return { status: 'resumed', templates: keys.size, days };
    }

    for (const [templateId, add] of keys) {
      if (!pauseFits(byId.get(templateId)!.get('skippedOccurrences'), add, today)) return { status: 'refused', reason: 'too-many' };
    }
    const remove = [...keys.values()].flat().flatMap(key => {
      const day = openByKey.get(key);
      return day && day.get('assignedToUid') === memberUid ? [day] : [];
    });
    for (const [templateId, add] of keys) {
      const snap = byId.get(templateId)!;
      tx.update(snap.ref, { skippedOccurrences: withSkippedOccurrences(snap.get('skippedOccurrences'), add, today) });
    }
    remove.forEach(doc => tx.delete(doc.ref));
    return { status: 'paused', templates: keys.size, removed: remove.length, days };
  });
}

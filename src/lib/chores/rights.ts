/**
 * Who may change or remove a chore or a library chore (CH-24). Mirrors the Firestore
 * rules: a member with `chores.delete` may remove any chore, and one with
 * `chores.edit` and `chores.delete` may change any repeat; besides, whoever created a
 * chore or a library chore (`createdByUid`, written by this client on create and never
 * changed) may, with `chores.create`, change and remove that library chore, stop or
 * change its repeat, and remove its open days and their own open one-time chores.
 * Completed chores stay for everyone without `chores.delete` (they hold points).
 * Older documents have no creator: only an admin can manage them ("Ask an admin").
 */
import type { ChoreTemplate } from '../types';
import type { ChoreRecord } from './dates';
import type { ChoreCapabilities } from './list';

type TemplateLike = Pick<ChoreTemplate, 'createdByUid'> | null | undefined;

/** Created by `uid` (with `chores.create`): the creator's own rights apply. */
const ownsIt = (createdByUid: unknown, uid: string | null | undefined, capabilities: ChoreCapabilities) =>
  capabilities.canCreate && typeof uid === 'string' && uid !== '' && createdByUid === uid;

/** A generated day of a repeat (upkeep writes no `sourceType`), as the rules read it. */
const isSeriesDay = (chore: Pick<ChoreRecord, 'templateId' | 'sourceType'>) =>
  typeof chore.templateId === 'string' && chore.templateId !== '' && (chore.sourceType === undefined || chore.sourceType === null);

export type TemplateRights = { edit: boolean; remove: boolean; repeat: boolean; own: boolean };

export function templateRights(template: TemplateLike, uid: string | null | undefined, capabilities: ChoreCapabilities): TemplateRights {
  const own = ownsIt(template?.createdByUid, uid, capabilities);
  return {
    own,
    edit: capabilities.canEdit || own,
    remove: capabilities.canDelete || own,
    // Changing or stopping a schedule rewrites the template and removes its open days.
    repeat: (capabilities.canEdit && capabilities.canDelete) || own,
  };
}

/** Whether `uid` may delete this chore (also: clear it as a missed day). */
export function mayRemoveChore(
  chore: Pick<ChoreRecord, 'isCompleted' | 'createdByUid' | 'templateId' | 'sourceType'>,
  template: TemplateLike,
  uid: string | null | undefined,
  capabilities: ChoreCapabilities,
): boolean {
  if (capabilities.canDelete) return true;
  if (chore.isCompleted) return false;
  return ownsIt(chore.createdByUid, uid, capabilities) || (isSeriesDay(chore) && ownsIt(template?.createdByUid, uid, capabilities));
}

/** The line a member sees where they cannot do something (CH-24). */
export const ASK_AN_ADMIN = 'Only the person who added it or an admin can change or remove it. Ask an admin.';

/** Why a check is disabled, or null when it is not (CH-24: never a silent dead end). */
export function disabledCheckHint(options: { canComplete: boolean; isFuture: boolean; dueLabel: string }): string | null {
  if (!options.canComplete) return 'You can see chores here but not tick them. Ask an admin.';
  if (options.isFuture) return `Not due yet. It can be ticked from ${options.dueLabel}.`;
  return null;
}

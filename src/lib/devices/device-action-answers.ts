// What a device action's answer means on the tablet (docs/modules/devices/README.md,
// "Device actions"). Pure, so the copy and the Undo decision are unit-tested.

import type { DeviceCapability } from './action-policy';

/** Each action capability and the capability that undoes it (only these offer Undo). */
export const UNDO_CAPABILITY_OF: Partial<Record<DeviceCapability, DeviceCapability>> = {
  'chores.complete': 'chores.complete.undo',
  'chores.take': 'chores.take.undo',
};

/** Capabilities the tablet can send to the server today (F4a: chores). Everything else is refused at once. */
export const SENDABLE_CAPABILITIES: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>([
  'chores.complete', 'chores.complete.undo', 'chores.take', 'chores.take.undo',
]);

export type ActionMeaning = {
  /** The action changed something this tablet may Undo (and points/credit went to the person). */
  undoable: boolean;
  /** The toast's text. */
  message: string;
  /** Shown as a plain notice rather than a success. */
  notice?: true;
};

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** The tablet's reading of a successful answer from a chore device action. */
export function choreAnswerMeaning(capability: DeviceCapability, data: unknown, label: string): ActionMeaning {
  const value = (data ?? {}) as Record<string, unknown>;
  if (capability === 'chores.complete') {
    const outcome = (value.outcome ?? {}) as Record<string, unknown>;
    if (outcome.status === 'completed') return { undoable: true, message: `${label}: done.` };
    if (outcome.status === 'already') {
      const by = str((outcome.completion as Record<string, unknown> | undefined)?.completedByName).trim();
      return { undoable: false, notice: true, message: by ? `Already done by ${by}.` : 'Already done.' };
    }
    if (outcome.status === 'refused' && outcome.refused === 'early') return { undoable: false, notice: true, message: "That chore isn't due yet." };
    return { undoable: false, notice: true, message: 'That chore is gone.' };
  }
  if (capability === 'chores.take') {
    if (value.status === 'taken') return { undoable: true, message: `${label}: it's yours.` };
    return { undoable: false, notice: true, message: "It's already yours." };
  }
  // Undo answers: undone, untaken, already (undone before) and not_applied (it never happened) all leave nothing to do.
  return { undoable: false, message: 'Undone.' };
}

// The device action policy (docs/modules/devices/README.md, "The device action gate").
// Pure: shared by the tablet UI (to decide what to offer) and the server gate
// (`src/lib/server/device-gate.ts`, which alone decides). Every action a tablet can
// reach is one capability in DEVICE_ACTION_POLICY; an action name not in the table is
// refused (`unclassified`, WT-6c).

import type { HouseholdPermission, HouseholdRole } from '@/lib/types';

export type DeviceSection = 'home' | 'chores' | 'shopping' | 'pets' | 'calendar' | 'maintenance' | 'automation';

/**
 * `device`: the tablet itself, no person (heartbeat, comfort settings).
 * `face`: the selected member, no PIN (only with `faceNeedsUndoProof` once proven).
 * `pin`: the selected member with a valid PIN session.
 * `admin-pin`: an owner or admin (role) with a fresh PIN session.
 * `not_on_tablets`: not offered on tablets yet (GT-2; refused as `not_on_tablets`, a permanent
 * answer). `never`: personal, never on a tablet (WT-10; refused the same way).
 */
export type DeviceLevelClass = 'device' | 'face' | 'pin' | 'admin-pin' | 'not_on_tablets' | 'never';

/** The household points-PIN setting (WT-9d, WT-22, D-T10). */
export type PointsPinPolicy = 'off' | 'kids' | 'everyone';
export const POINTS_PIN_POLICIES: readonly PointsPinPolicy[] = ['off', 'kids', 'everyone'];

export const readPointsPinPolicy = (household: { devicePolicy?: { pointsPin?: unknown } } | null | undefined): PointsPinPolicy => {
  const value = household?.devicePolicy?.pointsPin;
  return value === 'kids' || value === 'everyone' ? value : 'off';
};

export type DeviceCapabilityPolicy = {
  section: DeviceSection;
  levelClass: DeviceLevelClass;
  /**
   * Permissions of which the actor needs at least one. `null` = no permission check
   * (only for 'device' and 'admin-pin', whose authority is the device itself or the
   * owner/admin role). An empty array is a configuration error: it grants nothing.
   */
  permissions: readonly HouseholdPermission[] | null;
  /**
   * Extra actor rule, applied by the feature operation against the target record
   * inside its transaction (`assertActorRule` in the gate):
   * - `original-actor`: only the member who did the original action;
   * - `original-actor-or-delete-permission`: that member, or a holder of
   *   `actorRulePermission` at PIN level;
   * - `author-or-permission`: the record's author, or a holder of `actorRulePermission`.
   */
  actorRule?: 'original-actor' | 'original-actor-or-delete-permission' | 'author-or-permission';
  /** The permission named by `actorRule`. */
  actorRulePermission?: HouseholdPermission;
  /** WT-22: subject to the household points-PIN setting. */
  points?: true;
  /** May wait in the offline queue (face actions only). */
  queueable?: true;
  /** Face level only once the Undo proof is recorded (WT-20a); until then treated as 'pin'. */
  faceNeedsUndoProof?: true;
  /** Admin-PIN capabilities: the PIN session must be at most this old (S9). */
  freshPinSec?: number;
};

const ADD = ['pets.addLogs'] as const satisfies readonly HouseholdPermission[];
const ADD_OR_DELETE = ['pets.addLogs', 'pets.deleteLogs'] as const satisfies readonly HouseholdPermission[];
const EDIT_PROFILES = ['pets.editProfiles'] as const satisfies readonly HouseholdPermission[];

/** Face-level once proven (`face*`); queueable. */
const faceStar = (section: DeviceSection, permissions: readonly HouseholdPermission[], extra: Partial<DeviceCapabilityPolicy> = {}): DeviceCapabilityPolicy => ({
  section, levelClass: 'face', permissions, faceNeedsUndoProof: true, queueable: true, ...extra,
});
const pin = (section: DeviceSection, permissions: readonly HouseholdPermission[], extra: Partial<DeviceCapabilityPolicy> = {}): DeviceCapabilityPolicy => ({
  section, levelClass: 'pin', permissions, ...extra,
});
const notOnTablets = (section: DeviceSection): DeviceCapabilityPolicy => ({ section, levelClass: 'not_on_tablets', permissions: null });
const never = (): DeviceCapabilityPolicy => ({ section: 'home', levelClass: 'never', permissions: null });
const adminPin = (): DeviceCapabilityPolicy => ({ section: 'home', levelClass: 'admin-pin', permissions: null, freshPinSec: 30 });

/**
 * Every device-reachable action (section 8.2, as revised: JC-14 lead decision for pet
 * profile edits, chores face*). Backdated feeds and doses older than 12 hours are
 * their own `.old` capabilities (PIN, JC-27): the server picks the capability from the
 * intent's time (`backdatedCapability`), never from the client's choice.
 */
export const DEVICE_ACTION_POLICY = {
  // --- Pets -----------------------------------------------------------------
  'pets.feed': faceStar('pets', ADD),
  'pets.feed.backdated': faceStar('pets', ADD),
  'pets.feed.backdated.old': pin('pets', ADD),
  'pets.feed.undo': faceStar('pets', ADD_OR_DELETE, { actorRule: 'original-actor-or-delete-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.dose.give': faceStar('pets', ADD),
  'pets.dose.give.old': pin('pets', ADD),
  'pets.dose.undo': faceStar('pets', ADD_OR_DELETE, { actorRule: 'original-actor-or-delete-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.care.add': faceStar('pets', ADD),
  'pets.care.undo': faceStar('pets', ADD_OR_DELETE, { actorRule: 'original-actor-or-delete-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.note.add': faceStar('pets', ADD),
  'pets.note.undo': faceStar('pets', ADD_OR_DELETE, { actorRule: 'original-actor-or-delete-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.weight.add': faceStar('pets', ADD),
  'pets.weight.undo': faceStar('pets', ADD_OR_DELETE, { actorRule: 'original-actor-or-delete-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.note.pin': pin('pets', ['pets.addLogs', 'pets.editProfiles'], { actorRule: 'author-or-permission', actorRulePermission: 'pets.editProfiles' }),
  'pets.note.unpin': pin('pets', ['pets.addLogs', 'pets.editProfiles'], { actorRule: 'author-or-permission', actorRulePermission: 'pets.editProfiles' }),
  'pets.note.editPinned': pin('pets', ['pets.addLogs', 'pets.editProfiles'], { actorRule: 'author-or-permission', actorRulePermission: 'pets.editProfiles' }),
  'pets.note.delete': pin('pets', ADD_OR_DELETE, { actorRule: 'author-or-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.log.delete': pin('pets', ADD_OR_DELETE, { actorRule: 'author-or-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.log.correctTime': pin('pets', ADD_OR_DELETE, { actorRule: 'author-or-permission', actorRulePermission: 'pets.deleteLogs' }),
  'pets.medication.confirmLegacy': pin('pets', EDIT_PROFILES),
  'pets.course.edit': pin('pets', EDIT_PROFILES),
  'pets.course.finish': pin('pets', ADD),
  'pets.slots.confirm': pin('pets', EDIT_PROFILES),
  'pets.slots.edit': pin('pets', EDIT_PROFILES),
  'pets.profile.edit': pin('pets', EDIT_PROFILES),
  'pets.pet.create': pin('pets', EDIT_PROFILES),
  'pets.pet.delete': pin('pets', EDIT_PROFILES),
  'pets.photo.upload': notOnTablets('pets'),

  // --- Chores and household notices -----------------------------------------
  'chores.complete': faceStar('chores', ['chores.complete'], { points: true }),
  'chores.complete.undo': faceStar('chores', ['chores.complete'], { points: true, actorRule: 'original-actor' }),
  'chores.take': faceStar('chores', ['chores.assign'], { points: true }),
  'chores.take.undo': faceStar('chores', ['chores.assign'], { points: true, actorRule: 'original-actor' }),
  'chores.steps.tick': notOnTablets('chores'),
  'chores.move': notOnTablets('chores'),
  'chores.reopen.own': notOnTablets('chores'),
  'chores.reopen.others': notOnTablets('chores'),
  'chores.reassign.others': notOnTablets('chores'),
  'chores.edit.repeats': notOnTablets('chores'),
  'chores.manager': notOnTablets('chores'),
  'chores.leaderboard.hide': notOnTablets('chores'),
  'chores.delete': notOnTablets('chores'),
  'chores.upkeep': notOnTablets('chores'),
  'notifications.dismiss': { section: 'home', levelClass: 'face', permissions: ['notifications.dismiss'], faceNeedsUndoProof: true },
  'notifications.dismiss.undo': { section: 'home', levelClass: 'face', permissions: ['notifications.dismiss'], faceNeedsUndoProof: true, actorRule: 'original-actor' },

  // --- Shopping and maintenance: read-only sections in this goal (D-T8, JC-24) ---
  'shopping.add': notOnTablets('shopping'),
  'shopping.tick': notOnTablets('shopping'),
  'shopping.remove': notOnTablets('shopping'),
  'shopping.putAway': notOnTablets('shopping'),
  'shopping.usedUp': notOnTablets('shopping'),
  'shopping.scan': notOnTablets('shopping'),
  'maintenance.log': notOnTablets('maintenance'),
  'maintenance.snooze': notOnTablets('maintenance'),
  'maintenance.editSchedules': notOnTablets('maintenance'),

  // --- AI flows (JC-28) -----------------------------------------------------
  'ai.parse': notOnTablets('home'),
  'ai.overview': notOnTablets('home'),
  'ai.categorize': notOnTablets('shopping'),
  'ai.recipe': notOnTablets('shopping'),
  'ai.barcode': notOnTablets('shopping'),
  'ai.maintenanceSummary': notOnTablets('maintenance'),

  // --- The tablet itself ----------------------------------------------------
  'device.heartbeat': { section: 'home', levelClass: 'device', permissions: null },
  'device.comfort': { section: 'home', levelClass: 'device', permissions: null },
  'device.settings': adminPin(),
  'device.exit.remove': adminPin(),
  'device.exit.personal': adminPin(),
  'device.exit.newCode': adminPin(),

  // --- Household administration and automation (D-T4, GT-2) -----------------
  'household.members': notOnTablets('home'),
  'household.roles': notOnTablets('home'),
  'household.invites': notOnTablets('home'),
  'household.deviceCodes': notOnTablets('home'),
  'household.settings': notOnTablets('home'),
  'household.dangerZone': notOnTablets('home'),
  'automation.connection': notOnTablets('automation'),
  'automation.control': notOnTablets('automation'),

  // --- Personal things stay on phones (WT-10) -------------------------------
  'profile.edit': never(),
  'push.register': never(),
  'notifications.targeted': never(),
  'reminders.personal': never(),
} as const satisfies Record<string, DeviceCapabilityPolicy>;

export type DeviceCapability = keyof typeof DEVICE_ACTION_POLICY;

export const DEVICE_CAPABILITIES = Object.keys(DEVICE_ACTION_POLICY) as DeviceCapability[];

/**
 * Capabilities whose Undo is proven (tracker WT-20f evidence, section 10.4). Edited only
 * in the PR that records that evidence; until then every `face*` capability needs a PIN.
 */
export const UNDO_PROVEN: ReadonlySet<DeviceCapability> = new Set<DeviceCapability>([]);

export const isDeviceCapability = (value: unknown): value is DeviceCapability =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_ACTION_POLICY, value);

export const policyOf = (capability: DeviceCapability): DeviceCapabilityPolicy => DEVICE_ACTION_POLICY[capability];

/** An Undo capability (`….undo`): it takes the original action's opId. */
export const isUndoCapability = (capability: DeviceCapability): boolean => capability.endsWith('.undo');

/** Mutating face/PIN capabilities carry a client opId (section 10). */
export const requiresOpId = (capability: DeviceCapability): boolean => {
  const policy = policyOf(capability);
  return policy.levelClass === 'face' || policy.levelClass === 'pin';
};

/** Backdated feeds and doses: face* within the last 12 hours, PIN when older (JC-27). */
export const BACKDATED_FACE_WINDOW_MS = 12 * 60 * 60 * 1000;

export const backdatedCapability = (
  kind: 'feed' | 'dose',
  at: Date,
  now: Date,
): 'pets.feed.backdated' | 'pets.feed.backdated.old' | 'pets.dose.give' | 'pets.dose.give.old' => {
  const old = now.getTime() - at.getTime() > BACKDATED_FACE_WINDOW_MS;
  if (kind === 'feed') return old ? 'pets.feed.backdated.old' : 'pets.feed.backdated';
  return old ? 'pets.dose.give.old' : 'pets.dose.give';
};

export type RequiredLevel = 'device' | 'face' | 'pin' | 'admin-pin' | 'not_on_tablets' | 'never';

/**
 * The level an action needs right now (8.4 step 9): the class, with `face*` raised to
 * `pin` until its Undo is proven, and points actions raised to `pin` when the household
 * setting asks for it (Everyone; Kids only = every member with the Child role, D-T10).
 */
export const requiredLevel = (
  capability: DeviceCapability,
  context: { pointsPin: PointsPinPolicy; actorRole: HouseholdRole | null },
  undoProven: ReadonlySet<DeviceCapability> = UNDO_PROVEN,
): RequiredLevel => {
  const policy = policyOf(capability);
  if (policy.levelClass !== 'face') return policy.levelClass;
  if (policy.faceNeedsUndoProof && !undoProven.has(capability)) return 'pin';
  if (policy.points && (context.pointsPin === 'everyone' || (context.pointsPin === 'kids' && context.actorRole === 'child'))) return 'pin';
  return 'face';
};

/** Why a device action was refused (section 8.5). */
export type DeviceRefusal =
  | 'unauthenticated'
  | 'device_revoked'
  | 'not_a_device'
  | 'wrong_household'
  | 'household_deleting'
  | 'section_off'
  /** Retryable: the server flag is off or a verifier/backend outage (F1). Never ends the session. */
  | 'unavailable'
  /** Permanent: the capability is not offered on tablets (class not_on_tablets or never). */
  | 'not_on_tablets'
  | 'unclassified'
  | 'actor_required'
  | 'actor_not_member'
  | 'actor_inactive'
  | 'actor_guest'
  | 'forbidden'
  | 'admin_pin_required'
  | 'no_pin_set'
  | 'pin_required'
  | 'pin_fresh_required'
  | 'pin_session_invalid'
  | 'pin_wrong'
  | 'pin_locked'
  | 'pin_locked_member'
  | 'pin_unavailable'
  | 'changed_since'
  | 'undo_expired'
  | 'already_undone'
  | 'not_undoable'
  | 'stale_intent'
  | 'rate_limited'
  | 'busy'
  | 'invalid_input'
  | 'conflict'
  | 'failed';

/** What the tablet does with a refusal: a message, the revocation flow, "Who's here?", the PIN pad, nothing, or the queue notice. */
export type DeviceRefusalResponse =
  | { kind: 'revoked'; message: string }
  | { kind: 'message'; message: string; leaveSection?: true; clearFace?: true; /** Worth trying again later (never ends the session). */ retry?: true }
  | { kind: 'who' }
  | { kind: 'pin-pad'; message?: string }
  | { kind: 'silent' }
  | { kind: 'queue' };

/**
 * Tablet copy for a refusal (section 8.5). `name` is the selected member's name;
 * `kid` marks a child (their "no PIN" message asks a parent).
 */
export const deviceRefusalResponse = (
  code: DeviceRefusal,
  context: { name?: string; kid?: boolean; retryAfterSec?: number } = {},
): DeviceRefusalResponse => {
  const name = context.name?.trim() || 'This person';
  switch (code) {
    case 'unauthenticated':
    case 'device_revoked':
    case 'not_a_device':
    case 'wrong_household':
      return { kind: 'revoked', message: 'This tablet was removed.' };
    case 'household_deleting':
      return { kind: 'revoked', message: 'This household is being deleted.' };
    case 'section_off':
      return { kind: 'message', message: "That isn't available on this tablet.", leaveSection: true };
    case 'not_on_tablets':
    case 'unclassified':
      return { kind: 'message', message: "That isn't available on wall tablets yet. Use your phone." };
    case 'unavailable':
      return { kind: 'message', message: "Can't reach HomeHub right now. Try again in a moment.", retry: true };
    case 'actor_required':
      return { kind: 'who' };
    case 'actor_not_member':
    case 'actor_inactive':
    case 'actor_guest':
      return { kind: 'message', message: `${name} can't do that from this tablet any more.`, clearFace: true };
    case 'forbidden':
      return { kind: 'message', message: `${name}'s role doesn't allow that.` };
    case 'admin_pin_required':
      return { kind: 'message', message: 'An owner or admin PIN is needed.' };
    case 'no_pin_set':
      return { kind: 'message', message: context.kid ? `${name} needs a PIN first. Ask a parent to set one.` : `${name} needs a PIN first. Set one from your phone in Profile.` };
    case 'pin_required':
    case 'pin_fresh_required':
      return { kind: 'pin-pad' };
    case 'pin_session_invalid':
      return { kind: 'pin-pad', message: 'Enter your PIN again.' };
    case 'pin_wrong':
      return { kind: 'message', message: "That PIN isn't right." };
    case 'pin_locked': {
      const minutes = Math.max(1, Math.ceil((context.retryAfterSec ?? 60) / 60));
      return { kind: 'message', message: `Too many tries. Try again in ${minutes} min.` };
    }
    case 'pin_locked_member':
      return { kind: 'message', message: 'PIN locked. An owner or admin can unlock it from their phone.' };
    case 'pin_unavailable':
      return { kind: 'message', message: "PINs aren't working right now. Try again later." };
    case 'changed_since':
    case 'not_undoable':
      return { kind: 'message', message: "That changed since, so it can't be undone here." };
    case 'undo_expired':
      return { kind: 'message', message: 'Too late to undo.' };
    case 'already_undone':
      return { kind: 'silent' };
    case 'stale_intent':
      return { kind: 'queue' };
    case 'rate_limited':
    case 'busy':
      return { kind: 'message', message: 'One moment, try again.', retry: true };
    case 'invalid_input':
    case 'conflict':
    case 'failed':
    default:
      return { kind: 'message', message: "Couldn't save. Try again." };
  }
};

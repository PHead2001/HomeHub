import type { ProfileAppearance } from './theme/appearance';









export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

export type RecurrenceFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export type MonthlyRecurrenceMode = 'dayOfMonth' | 'nthWeekday';

export type MonthlyNthWeekday = {
  week: 1 | 2 | 3 | 4;
  dayOfWeek: number; // 0 for Sunday, 1 for Monday, etc.
};

export type Recurrence = {
  frequency: RecurrenceFrequency;
  interval: number; // e.g., every 1 week, every 2 weeks
  /** Legacy copy of the assignee's email on older templates; never written since member privacy release C. */
  assignedToEmail?: string;
  startDate?: string; // yyyy-MM-dd anchor date for interval-based schedules
  dailyOptions?: {
    excludeWeekends: boolean;
  };
  weeklyOptions?: {
    daysOfWeek: number[]; // 0 for Sunday, 1 for Monday, etc.
  };
  monthlyOptions?: {
    mode?: MonthlyRecurrenceMode;
    dayOfMonth?: number; // 1-28
    nthWeekday?: MonthlyNthWeekday;
  };
};


export type Pet = {
  id: string; // Document ID
  name: string;
  type: 'Dog' | 'Cat' | 'Other';
  photoUrl: string;
  dataAiHint: string;
  foodSchedule: string;
};

export type FeedingLog = {
  id: string;
  date: Date;
  cups: number;
  foodType: 'Dry' | 'Wet' | 'Mix';
  foodAmountType: 'Cups' | 'Cans' | 'Scoops' | 'Other';
  comments: string;
  ampm: 'AM' | 'PM';
}

export type MedicationLog = {
  id: string;
  date: string; // ISO string
  medication: string;
  dosage: string;
  notes: string;
}

export type CareLog = {
  id:string;
  date: string; // ISO string
  activity: string;
  notes: string;
}

export type ShoppingListType = 'Grocery' | 'Auto' | 'Hardware' | 'Pets' | 'Custom';

export type ShoppingList = {
    id: string; // a slug of the name
    name: string;
    description: string;
    icon: string; // Lucide icon name
    type: ShoppingListType;
    color?: string; // Hex color code
    /** The store whose aisle order the open list follows (`stores/{storeId}`); null or absent: the list's own order. */
    storeId?: string | null;
    /** Who created the list (the signed-in uid at creation). Absent on lists made by older clients. */
    createdByUid?: string;
};

/**
 * A store the household shops at (`households/{householdId}/stores/{storeId}`),
 * with the order its aisles are walked in (category names, at most 200). Lists
 * that name it in `storeId` group their needed items in this order.
 */
export type ShoppingStore = {
    id: string;
    name: string;
    aisleOrder: string[];
    createdByUid?: string;
    updatedAt?: unknown;
};

export type ShoppingListItem = {
  id:string;
  name: string;
  quantity: number;
  category: ShoppingListCategory;
  createdAt: Date;
  status: 'needed' | 'purchased';
  imageUrl?: string;
  barcode?: string;
  /** Link saved with an item shared into HomeHub (recipe or product page). http(s) only. */
  sourceUrl?: string;
  /** Normalized name (`itemNameKey`), written on new items (SH-28a). */
  nameKey?: string;
  /** Who added the item (the signed-in uid at creation; immutable). Shown on rows from S3. */
  addedByUid?: string;
  /** Who restored the item with Undo after a delete (the writer of that re-create); `addedByUid` stays the original adder. */
  restoredByUid?: string;
  /** Where `category` came from (QA-6): manual, remembered, local, ai, fallback or pending. */
  categorySource?: 'manual' | 'remembered' | 'local' | 'ai' | 'fallback' | 'pending';
  /** Package size of a scanned product ("450" of 450 g); never the quantity (BL-1). */
  size?: number;
  /** Unit of `size` ("g", "fl oz"). */
  sizeUnit?: string;
  /** Who ticked it (the writer's uid) and when (server time); cleared by an un-tick or Undo (S3). */
  purchasedByUid?: string | null;
  purchasedAt?: unknown;
  /** Fresh id of the latest tick; its Undo must name it (`undoOpId`), so a newer tick by anyone wins. */
  purchaseOpId?: string;
  /** The `purchaseOpId` an Undo reversed (rules: only while it is still the current purchase). */
  undoOpId?: string;
  /** Id of the Undo-after-delete that re-created this item (rules: create only). */
  /** When that restore was written (server time; rules: create only, so a replayed restore is refused). */
  restoredAt?: unknown;
  restoreOpId?: string;
  /** Who last edited it in the item sheet (the writer's uid) and when (server time) (SH-8a/b). */
  editedByUid?: string;
  editedAt?: unknown;
  /** Server-only (S5): when a "Put away" trip credited this purchase to the pantry, and that trip's id. */
  pantryCreditedAt?: unknown;
  creditTripId?: string;
};

export type ShoppingListCategory = string;

export type PantryItemUnit = 
  | 'g' | 'kg' | 'oz' | 'lbs' // Weight
  | 'ml' | 'L' | 'fl oz' // Volume
  | 'items' | 'cans' | 'bottles' | 'pieces' | 'slices'; // Count


export const pantryItemUnitCategories = {
  'Weight': ['g', 'kg', 'oz', 'lbs'],
  'Volume': ['ml', 'L', 'fl oz'],
  'Count': ['items', 'cans', 'bottles', 'pieces', 'slices'],
} as const;

export type PantryItemLocation = 'Pantry' | 'Fridge' | 'Freezer';

/**
 * A stored pantry document (`households/{h}/pantry-inventory/{id}`), one per
 * batch in Pantry v2. Documents written before v2 carry only `name`, `quantity`,
 * `unit`, `location` and an ISO `expiryDate`; read any document through
 * `readPantryBatch` (src/lib/shopping/pantry-batches.ts), never these fields directly.
 */
export type PantryItem = {
  id: string;
  name: string;
  /** Legacy amount, still dual-written: packages for counted units, the package size for measured ones. */
  quantity?: number;
  unit: PantryItemUnit;
  location: PantryItemLocation;
  /** v2: `yyyy-MM-dd` in the household zone; legacy documents hold an ISO instant of local midnight. */
  expiryDate?: string | null;
  nameKey?: string;
  /** v2: number of packages (0..10000); 0 means used up. */
  packages?: number;
  /** v2: size of one package in `unit`, or null. */
  packageSize?: number | null;
  barcode?: string | null;
  addedByUid?: string;
  updatedByUid?: string;
  updatedAt?: unknown;
  schemaVersion?: number;
};

export type HomeAssetCategory =
  | 'HVAC'
  | 'Appliance'
  | 'Plumbing'
  | 'Electrical'
  | 'Network'
  | 'Smart Home'
  | 'Lawn / Outdoor'
  | 'Tool'
  | 'Other';

export type HomeAssetStatus = 'active' | 'needs_attention' | 'retired';

export type MaintenanceScheduleMode = 'scheduled' | 'checklist';

export type HomeAssetSchedule = {
  /** Set by Snooze to the due date it moved to; quiets the push until then (see functions/src/shared/maintenance-reminders.ts). */
  snoozedUntil?: string;
  id?: string;
  mode?: MaintenanceScheduleMode;
  scheduleName?: string;
  frequencyType?: 'days' | 'weeks' | 'months' | 'years';
  intervalValue?: number;
  lastCompletedDate?: string;
  nextDueDate?: string;
};

export type HomeAsset = {
  id: string;
  householdId: string;
  name: string;
  category: HomeAssetCategory;
  location?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  purchaseDate?: string;
  purchasePrice?: number;
  warrantyExpiration?: string;
  warrantyProvider?: string;
  status: HomeAssetStatus;
  notes?: string;
  schedules?: HomeAssetSchedule[];
  createdAt: string;
  updatedAt: string;
};

export type VehicleStatus = 'active' | 'needs_attention' | 'retired' | 'sold';

export type VehicleServiceSchedule = {
  /** Set by Snooze to the due date it moved to; quiets the push until then (see functions/src/shared/maintenance-reminders.ts). */
  snoozedUntil?: string;
  id?: string;
  mode?: MaintenanceScheduleMode;
  serviceName?: string;
  intervalMiles?: number;
  intervalMonths?: number;
  lastCompletedMileage?: number;
  lastCompletedDate?: string;
  nextDueMileage?: number;
  nextDueDate?: string;
};

export type Vehicle = {
  id: string;
  householdId: string;
  nickname: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  vin?: string;
  licensePlate?: string;
  currentMileage?: number;
  purchaseDate?: string;
  purchasePrice?: number;
  insuranceProvider?: string;
  registrationExpiration?: string;
  inspectionExpiration?: string;
  status: VehicleStatus;
  notes?: string;
  serviceSchedules?: VehicleServiceSchedule[];
  createdAt: string;
  updatedAt: string;
};

export type MaintenanceTargetType = 'home_asset' | 'vehicle' | 'general';

export type MaintenanceLogType =
  | 'repair'
  | 'routine'
  | 'inspection'
  | 'cleaning'
  | 'replacement'
  | 'issue'
  | 'other';

export type MaintenanceLog = {
  id: string;
  householdId?: string;
  targetType?: MaintenanceTargetType;
  assetId?: string;
  vehicleId?: string;
  formerTargetType?: Exclude<MaintenanceTargetType, 'general'>;
  formerTargetName?: string;
  title?: string;
  item?: string; // Legacy maintenance logs used item instead of title.
  date: string;
  type?: MaintenanceLogType;
  notes?: string;
  cost?: number;
  partsUsed?: string;
  serviceProvider?: string;
  mileage?: number;
  createdAt?: string;
  updatedAt?: string;
  summary?: string;
  receiptUrl?: string;
};

export type MaintenanceAttachmentTargetType = 'home_asset' | 'vehicle' | 'maintenance_log';

export type MaintenanceAttachmentCategory =
  | 'photo'
  | 'receipt'
  | 'manual'
  | 'warranty_document'
  | 'invoice'
  | 'other';

export type MaintenanceAttachment = {
  id: string;
  householdId: string;
  targetType: MaintenanceAttachmentTargetType;
  targetId: string;
  category: MaintenanceAttachmentCategory;
  fileName: string;
  filePath: string;
  downloadUrl?: string;
  contentType?: string;
  size?: number;
  uploadedByUid?: string;
  uploadedByName?: string;
  createdAt: string;
};

export type Room = {
    id: string;
    name: string;
    icon: string;
}

export type ChoreTemplate = {
    id: string;
    task: string;
    roomIds?: string[];
    notes?: string;
    subTasks?: string[];
    recurrence?: Recurrence | null;
    /** Assignee's Auth uid, the only assignee field written since member privacy release C (functions/src/shared/assignee.ts). */
    assignedToUid?: string | null;
    /** Legacy assignee email on older templates; read as a fallback, never written. */
    assignedToEmail?: string | null;
}

export type Chore = {
  id: string;
  task: string;
  /** Assignee's Auth uid ("" when unassigned); very old chores have only the email. Read through functions/src/shared/assignee.ts. */
  assignedToUid?: string;
  /** Legacy assignee key on older chores; read as a fallback, never written since member privacy release C. */
  assignedToEmail?: string;
  assignedToDisplayName?: string;
  dueDate: string;
  isCompleted: boolean;
  completedAt?: string | null; // ISO String for when the chore was marked as complete
  notes?: string;
  subTasks?: string[];
  completedSubTasks?: string[];
  templateId?: string; // Present for chores created from reusable templates.
  sourceType?: 'template' | 'temporary';
  originalDueDate: string; // To identify which instance of a recurring chore this is
  roomIds?: string[];
  /** Generated chores: "templateId|roomId|day", fixed at generation (CH-3). Server-written. */
  occurrenceKey?: string;
  /** Who completed it (D-7), written only by the completion server action. */
  completedByUid?: string | null;
  completedByEmail?: string | null;
  completedByName?: string | null;
  /** Random id of the current completion; Undo succeeds only while it still matches. */
  completionId?: string | null;
};

export type UserRole = 'owner' | 'admin' | 'member' | 'child' | 'guest' | 'newuser' | 'super-admin' | 'user';

export type HouseholdRole = 'owner' | 'admin' | 'member' | 'child' | 'guest' | 'newuser';

export type HouseholdPermission =
  | 'household.view'
  | 'household.manageMembers'
  | 'household.manageInvites'
  | 'household.manageRoles'
  | 'household.delete'
  | 'household.transferOwnership'
  | 'chores.view'
  | 'chores.complete'
  | 'chores.create'
  | 'chores.edit'
  | 'chores.delete'
  | 'chores.assign'
  | 'shopping.view'
  | 'shopping.edit'
  | 'shopping.delete'
  | 'pets.view'
  | 'pets.addLogs'
  | 'pets.editProfiles'
  | 'pets.deleteLogs'
  | 'maintenance.view'
  | 'maintenance.createLogs'
  | 'maintenance.edit'
  | 'maintenance.delete'
  | 'automation.view'
  | 'automation.control'
  | 'automation.manage'
  | 'notifications.view'
  | 'notifications.dismiss';

export type PermissionOverrides = Partial<Record<HouseholdPermission, boolean>>;

// 'deleting': the household is being deleted; rules grant nothing to non-active members.
export type HouseholdMemberStatus = 'active' | 'pending' | 'deleting';

export type HouseholdMember = {
  uid: string;
  /**
   * Not stored on membership records: the email lives in the protected contact
   * document (`members/{uid}/private/contact`). Filled in for member managers from
   * that document and for the viewer's own record; older records may still carry it
   * until scripts/ops/scrub-member-emails.mjs removes it.
   */
  email?: string;
  displayName?: string;
  avatarUrl?: string | null;
  role: HouseholdRole;
  status: HouseholdMemberStatus;
  inviteCode?: string;
  permissions?: PermissionOverrides;
  joinedAt: string;
  /** Household name at the time of joining, so a pending person never needs the household document. */
  householdName?: string;
  lastActiveAt?: string;
  lastNewUserReminderAt?: string;
  approvedAt?: string;
  approvedByUid?: string;
  /**
   * `'identity'`: a kid profile with no sign-in (`members/kid_<id>`, role `child`, no
   * contact document, no Auth user; docs/modules/devices/README.md). Absent: an account.
   */
  kind?: 'account' | 'identity';
  createdByUid?: string;
};

export type HomeAssistantCredentials = {
    url: string;
    accessToken: string;
};

export type BarcodeLibraryItem = {
  id: string; // barcode number
  name: string;
  imageUrl: string;
  imagePath?: string;
  createdAt: string; // ISO String
  /** Who saved the product (the writer of the create; immutable). Absent on older products. */
  createdByUid?: string;
};


export type LegacyProfileTheme = {
  background?: string;
  accent?: string;
  backgroundHex?: string;
  accentHex?: string;
};

export type User = {
  uid: string; // From Firebase Auth
  email: string;
  /** IANA timezone captured from the browser; used for daily chore reminders. */
  timeZone?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  permissions?: PermissionOverrides;
  forcePasswordChange?: boolean;
  householdId: string | null;
  /**
   * Appearance (Profile → Appearance). Version 2 stores curated preset choices;
   * the legacy free-color shape `{ background, accent, backgroundHex, accentHex }`
   * may still exist on old profiles and is ignored.
   */
  theme?: ProfileAppearance | LegacyProfileTheme | null;
  choreSettings?: {
    reminderTime: string; // e.g. "17:00"
    reminderEnabled: boolean;
  }
  /**
   * Legacy push tokens. New tokens live in `users/{email}/private/push`, which
   * only the owner can read; this field only shrinks until the migration empties it.
   */
  fcmTokens?: string[];
};

export type Household = {
    id: string;
    name: string;
    /** Legacy display data (never grants access); no longer written (member privacy release C), scrubbed by ops. */
    ownerEmail?: string;
    ownerUid?: string;
    /** Legacy display data (never grants access); no longer written (member privacy release C), scrubbed by ops. */
    memberEmails?: string[];
    /** ISO string; absent while pending (the person only knows the name). */
    createdAt?: string;
    inviteCode?: string;
    updatedAt?: string;
    /** Set when the owner starts deleting the household; data is frozen until removal finishes. */
    deletingAt?: unknown;
    deletingByUid?: string;
    /** IANA timezone used for reminders and recurring chores (default America/Chicago). */
    timeZone?: string;
    /** Wall-tablet policy (server-written; docs/modules/devices/README.md). Absent: points PIN off. */
    devicePolicy?: { pointsPin?: 'off' | 'kids' | 'everyone' };
}

export type InviteCode = {
  id: string;
  code: string;
  householdId: string;
  householdName: string;
  createdByUid: string;
  createdByEmail: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  usedByUid?: string;
  usedAt?: string;
  maxUses?: number;
  useCount?: number;
};

export type AuditLog = {
  id: string;
  actorUid?: string;
  actorEmail?: string;
  actorName?: string;
  action: string;
  targetUid?: string;
  targetEmail?: string;
  targetName?: string;
  createdAt: string;
  details?: Record<string, string | number | boolean | null>;
  /** Entries written for wall tablets (docs/modules/devices/README.md). */
  via?: string;
  deviceName?: string;
  level?: 'face' | 'pin' | 'device';
};

export type NotificationCategory =
  | 'chores'
  | 'pets'
  | 'shopping'
  | 'maintenance'
  | 'automation'
  | 'system'
  | 'general';

export type NotificationUserAction = {
  at: Date;
  uid?: string;
  email?: string;
  displayName?: string;
};

export type NotificationUserActionMap = Record<string, NotificationUserAction>;

export type Notification = {
  id: string;
  householdId: string;
  category: NotificationCategory;
  title?: string;
  message: string;
  createdAt: Date;
  expiresAt: Date;
  deepLink?: string;
  href?: string;
  sourceType?: string;
  sourceId?: string;
  stateKey?: string;
  targetUserUid?: string;
  targetUserEmail?: string;
  /** Who it is for: `[uid]` or `['*']`; absent on documents written before the field existed. */
  audience?: string[];
  readBy: NotificationUserActionMap;
  dismissedBy: NotificationUserActionMap;
  resolvedAt?: Date;
  resolvedBy?: NotificationUserAction;
  isRead?: boolean;
};

export type HomeAssistantEntity = {
    entity_id: string;
    state: string;
    attributes: {
        friendly_name?: string;
        [key: string]: JsonValue | undefined;
    }
}

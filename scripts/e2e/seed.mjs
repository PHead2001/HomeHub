import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PROJECT_ID = "demo-homehub-e2e";
const OWNER = {
  uid: "e2e-owner-uid",
  email: "alex.e2e@example.test",
  displayName: "Alex E2E",
};
const LIMITED_USER = {
  uid: "e2e-limited-uid",
  email: "casey.limited@example.test",
  displayName: "Casey Limited",
};
const LEGACY_USER = {
  uid: "e2e-legacy-uid",
  email: "riley.legacy@example.test",
  displayName: "Riley Legacy",
};
const HOUSEHOLD_B_OWNER = {
  uid: "e2e-household-b-owner-uid",
  email: "taylor.household-b@example.test",
  displayName: "Taylor Household B",
};
const HOUSEHOLD_ID = "the-foxy-residence-e2e";
const HOUSEHOLD_NAME = "The Foxy Residence E2E";
const HOUSEHOLD_B_ID = "the-otter-residence-e2e";
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/;
const FIXED_NOW = new Date("2026-08-01T12:00:00.000Z");

const assertSafeEmulatorEnvironment = () => {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;

  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true") {
    throw new Error("Refusing to seed: NEXT_PUBLIC_USE_FIREBASE_EMULATORS must be true.");
  }
  if (projectId !== PROJECT_ID || !projectId.startsWith("demo-")) {
    throw new Error(`Refusing to seed: project ID must be ${PROJECT_ID}.`);
  }
  if (!authHost || !LOOPBACK_HOST.test(authHost)) {
    throw new Error("Refusing to seed: FIREBASE_AUTH_EMULATOR_HOST must be a loopback host.");
  }
  if (!firestoreHost || !LOOPBACK_HOST.test(firestoreHost)) {
    throw new Error("Refusing to seed: FIRESTORE_EMULATOR_HOST must be a loopback host.");
  }
  if (!storageHost || !LOOPBACK_HOST.test(storageHost)) {
    throw new Error("Refusing to seed: FIREBASE_STORAGE_EMULATOR_HOST must be a loopback host.");
  }
};

const timestamp = (iso) => Timestamp.fromDate(new Date(iso));

const notificationId = (sourceType, sourceId, stateKey) => {
  const identity = `${sourceType}|${sourceId}|${stateKey}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${sourceType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${(hash >>> 0).toString(36)}`;
};

assertSafeEmulatorEnvironment();

const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
const auth = getAuth(app);
const db = getFirestore(app);

for (const user of [OWNER, LIMITED_USER, LEGACY_USER, HOUSEHOLD_B_OWNER]) {
  try {
    await auth.getUser(user.uid);
    await auth.updateUser(user.uid, {
      email: user.email,
      displayName: user.displayName,
      emailVerified: true,
    });
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw error;
    }
    await auth.createUser({
      ...user,
      emailVerified: true,
    });
  }
}

const household = db.collection("households").doc(HOUSEHOLD_ID);
const householdB = db.collection("households").doc(HOUSEHOLD_B_ID);
await Promise.all([db.recursiveDelete(household), db.recursiveDelete(householdB)]);

const batch = db.batch();
const set = (path, data) => batch.set(db.doc(path), data);

set(`users/${OWNER.email}`, {
  email: OWNER.email,
  displayName: OWNER.displayName,
  firstName: "Alex",
  lastName: "E2E",
  avatarUrl: null,
  role: "owner",
  permissions: {},
  householdId: HOUSEHOLD_ID,
  forcePasswordChange: false,
  fcmTokens: [],
  theme: null,
});
set(`users/${LIMITED_USER.email}`, {
  email: LIMITED_USER.email,
  displayName: LIMITED_USER.displayName,
  firstName: "Casey",
  lastName: "Limited",
  avatarUrl: null,
  role: "guest",
  permissions: {},
  householdId: HOUSEHOLD_ID,
  fcmTokens: [],
});
set(`users/${LEGACY_USER.email}`, {
  email: LEGACY_USER.email,
  displayName: LEGACY_USER.displayName,
  firstName: "Riley",
  lastName: "Legacy",
  avatarUrl: null,
  role: "super-admin",
  permissions: { "household.delete": true, "shopping.delete": true },
  householdId: HOUSEHOLD_ID,
  fcmTokens: [],
});
set(`users/${HOUSEHOLD_B_OWNER.email}`, {
  email: HOUSEHOLD_B_OWNER.email,
  displayName: HOUSEHOLD_B_OWNER.displayName,
  firstName: "Taylor",
  lastName: "B",
  avatarUrl: null,
  role: "owner",
  permissions: {},
  householdId: HOUSEHOLD_B_ID,
  fcmTokens: [],
});
set("users/morgan.admin@example.test", {
  email: "morgan.admin@example.test",
  displayName: "Morgan Admin",
  firstName: "Morgan",
  lastName: "Admin",
  avatarUrl: null,
  role: "admin",
  permissions: {},
  householdId: HOUSEHOLD_ID,
});
set("users/sam.member@example.test", {
  email: "sam.member@example.test",
  displayName: "Sam Member",
  firstName: "Sam",
  lastName: "Member",
  avatarUrl: null,
  role: "member",
  permissions: {},
  householdId: HOUSEHOLD_ID,
});
set("users/jamie.pending@example.test", {
  email: "jamie.pending@example.test",
  displayName: "Jamie Pending",
  firstName: "Jamie",
  lastName: "Pending",
  avatarUrl: null,
  role: "newuser",
  permissions: {},
  householdId: HOUSEHOLD_ID,
});

batch.set(household, {
  name: HOUSEHOLD_NAME,
  ownerUid: OWNER.uid,
  ownerEmail: OWNER.email,
  memberEmails: [
    OWNER.email,
    "morgan.admin@example.test",
    "sam.member@example.test",
    "jamie.pending@example.test",
    LIMITED_USER.email,
    LEGACY_USER.email,
  ],
  createdAt: "2026-01-15T15:00:00.000Z",
  updatedAt: FIXED_NOW.toISOString(),
});

const members = [
  {
    uid: OWNER.uid,
    email: OWNER.email,
    displayName: OWNER.displayName,
    role: "owner",
    status: "active",
    joinedAt: "2026-01-15T15:00:00.000Z",
    lastActiveAt: FIXED_NOW.toISOString(),
  },
  {
    uid: "e2e-admin-uid",
    email: "morgan.admin@example.test",
    displayName: "Morgan Admin",
    role: "admin",
    status: "active",
    joinedAt: "2026-02-03T14:00:00.000Z",
  },
  {
    uid: "e2e-member-uid",
    email: "sam.member@example.test",
    displayName: "Sam Member",
    role: "member",
    status: "active",
    joinedAt: "2026-03-10T18:30:00.000Z",
  },
  {
    uid: "e2e-pending-uid",
    email: "jamie.pending@example.test",
    displayName: "Jamie Pending",
    role: "newuser",
    status: "pending",
    joinedAt: "2026-07-31T18:00:00.000Z",
  },
  {
    uid: LIMITED_USER.uid,
    email: LIMITED_USER.email,
    displayName: LIMITED_USER.displayName,
    role: "guest",
    status: "active",
    permissions: { "shopping.view": false, "notifications.view": false },
    joinedAt: "2026-07-15T18:00:00.000Z",
  },
];
for (const member of members) {
  batch.set(household.collection("members").doc(member.uid), {
    ...member,
    permissions: member.permissions || {},
    avatarUrl: null,
  });
}

batch.set(householdB, {
  name: "The Otter Residence E2E",
  ownerUid: HOUSEHOLD_B_OWNER.uid,
  ownerEmail: HOUSEHOLD_B_OWNER.email,
  memberEmails: [HOUSEHOLD_B_OWNER.email],
  createdAt: "2026-01-20T15:00:00.000Z",
  updatedAt: FIXED_NOW.toISOString(),
});
batch.set(householdB.collection("members").doc(HOUSEHOLD_B_OWNER.uid), {
  ...HOUSEHOLD_B_OWNER,
  role: "owner",
  status: "active",
  permissions: {},
  joinedAt: "2026-01-20T15:00:00.000Z",
});
batch.set(householdB.collection("chores").doc("private-b-chore"), {
  task: "HOUSEHOLD-B-PRIVATE-CHORE",
  assignedToEmail: HOUSEHOLD_B_OWNER.email,
  dueDate: "2026-08-01",
  isCompleted: false,
  originalDueDate: "2026-08-01",
});
batch.set(householdB.collection("barcode-library").doc("012345678905"), {
  name: "HOUSEHOLD-B-PRIVATE-PRODUCT",
  imageUrl: "",
  createdAt: "2026-07-25T15:00:00.000Z",
});

batch.set(household.collection("auditLogs").doc("seed-member-joined"), {
  actorUid: OWNER.uid,
  actorEmail: OWNER.email,
  actorName: OWNER.displayName,
  action: "member.joined",
  targetUid: "e2e-pending-uid",
  targetEmail: "jamie.pending@example.test",
  targetName: "Jamie Pending",
  createdAt: "2026-07-31T18:00:00.000Z",
  details: { source: "invite" },
});

const rooms = [
  ["kitchen", { name: "Kitchen", icon: "CookingPot" }],
  ["living-room", { name: "Living Room", icon: "Sofa" }],
  ["garage", { name: "Garage", icon: "Warehouse" }],
];
for (const [id, data] of rooms) {
  batch.set(household.collection("rooms").doc(id), data);
}

batch.set(household.collection("chore-templates").doc("daily-kitchen-reset"), {
  task: "Reset the kitchen",
  roomIds: ["kitchen"],
  notes: "Wipe counters and load the dishwasher.",
  subTasks: ["Wipe counters", "Load dishwasher", "Sweep floor"],
  assignedToEmail: OWNER.email,
  recurrence: {
    frequency: "daily",
    interval: 1,
    assignedToEmail: OWNER.email,
    startDate: "2026-07-01",
    dailyOptions: { excludeWeekends: false },
  },
});
batch.set(household.collection("chore-templates").doc("biweekly-yard-check"), {
  task: "Check outdoor equipment",
  roomIds: ["garage"],
  assignedToEmail: "sam.member@example.test",
  recurrence: {
    frequency: "biweekly",
    interval: 2,
    assignedToEmail: "sam.member@example.test",
    startDate: "2026-07-20",
    weeklyOptions: { daysOfWeek: [6] },
  },
});

const chores = [
  ["chore-kitchen", {
    task: "Reset the kitchen",
    assignedToEmail: OWNER.email,
    assignedToDisplayName: OWNER.displayName,
    dueDate: "2026-08-01",
    isCompleted: false,
    notes: "Finish before dinner.",
    subTasks: ["Wipe counters", "Load dishwasher", "Sweep floor"],
    completedSubTasks: ["Wipe counters"],
    templateId: "daily-kitchen-reset",
    originalDueDate: "2026-08-01",
    roomIds: ["kitchen"],
  }],
  ["chore-laundry", {
    task: "Fold clean laundry",
    assignedToEmail: "sam.member@example.test",
    assignedToDisplayName: "Sam Member",
    dueDate: "2026-08-01",
    isCompleted: false,
    templateId: "one-time-laundry",
    originalDueDate: "2026-08-01",
    roomIds: ["living-room"],
  }],
  ["chore-completed", {
    task: "Take bins to curb",
    assignedToEmail: "morgan.admin@example.test",
    assignedToDisplayName: "Morgan Admin",
    dueDate: "2026-07-31",
    isCompleted: true,
    completedAt: "2026-07-31T20:10:00.000Z",
    templateId: "one-time-bins",
    originalDueDate: "2026-07-31",
    roomIds: ["garage"],
  }],
];
for (const [id, data] of chores) {
  batch.set(household.collection("chores").doc(id), data);
}

const lists = [
  ["weekly-groceries", {
    name: "Weekly Groceries",
    description: "Kitchen staples and produce",
    icon: "ShoppingCart",
    type: "Grocery",
    color: "#22c55e",
  }],
  ["hardware-run", {
    name: "Hardware Run",
    description: "Supplies for weekend projects",
    icon: "Hammer",
    type: "Hardware",
    color: "#f59e0b",
  }],
];
for (const [id, data] of lists) {
  batch.set(household.collection("shopping-lists").doc(id), data);
}
batch.set(household.collection("shopping-lists").doc("weekly-groceries").collection("config").doc("categories"), {
  list: ["Produce", "Dairy", "Pantry", "Household"],
});

const shoppingItems = [
  ["weekly-groceries", "milk", { name: "Whole milk", quantity: 1, category: "Dairy", status: "needed", createdAt: timestamp("2026-07-31T14:00:00.000Z") }],
  ["weekly-groceries", "apples", { name: "Honeycrisp apples", quantity: 6, category: "Produce", status: "needed", createdAt: timestamp("2026-07-31T14:05:00.000Z") }],
  ["weekly-groceries", "coffee", { name: "Coffee beans", quantity: 1, category: "Pantry", status: "purchased", createdAt: timestamp("2026-07-30T16:00:00.000Z") }],
  ["hardware-run", "filters", { name: "HVAC filters", quantity: 2, category: "Other", status: "needed", createdAt: timestamp("2026-07-29T18:00:00.000Z") }],
];
for (const [listId, id, data] of shoppingItems) {
  batch.set(household.collection("shopping-lists").doc(listId).collection("items").doc(id), data);
}

const pantryItems = [
  ["rice", { name: "Jasmine rice", quantity: 4, unit: "lbs", location: "Pantry", expiryDate: "2027-02-01" }],
  ["yogurt", { name: "Greek yogurt", quantity: 3, unit: "items", location: "Fridge", expiryDate: "2026-08-04" }],
  ["berries", { name: "Frozen berries", quantity: 2, unit: "bags", location: "Freezer", expiryDate: "2026-12-15" }],
];
for (const [id, data] of pantryItems) {
  batch.set(household.collection("pantry-inventory").doc(id), data);
}

batch.set(household.collection("barcode-library").doc("012345678905"), {
  name: "E2E Oat Cereal",
  imageUrl: "/favicon.ico",
  createdAt: "2026-07-25T15:00:00.000Z",
});

const pets = [
  ["maple", { name: "Maple", type: "Dog", photoUrl: "/favicon.ico", dataAiHint: "golden dog", foodSchedule: "1.5 cups twice daily" }],
  ["pixel", { name: "Pixel", type: "Cat", photoUrl: "/favicon.ico", dataAiHint: "gray cat", foodSchedule: "One can morning and evening" }],
];
for (const [id, data] of pets) {
  batch.set(household.collection("pets").doc(id), data);
}
batch.set(household.collection("pets").doc("maple").collection("feeding-logs").doc("morning-feed"), {
  date: timestamp("2026-08-01T12:00:00.000Z"),
  cups: 1.5,
  foodType: "Dry",
  foodAmountType: "Cups",
  comments: "Ate normally",
  ampm: "AM",
});
batch.set(household.collection("pets").doc("maple").collection("care-logs").doc("walk"), {
  date: "2026-07-31T23:30:00.000Z",
  activity: "Evening walk",
  notes: "Thirty minutes around the neighborhood.",
});
batch.set(household.collection("pets").doc("pixel").collection("medication-logs").doc("flea-prevention"), {
  date: "2026-07-28T15:00:00.000Z",
  medication: "Monthly flea prevention",
  dosage: "One topical dose",
  notes: "Next dose due in four weeks.",
});

const assets = [
  ["hvac-main", {
    householdId: HOUSEHOLD_ID,
    name: "Main HVAC System",
    category: "HVAC",
    location: "Utility Closet",
    brand: "Carrier",
    model: "Comfort 16",
    serialNumber: "E2E-HVAC-001",
    purchaseDate: "2022-05-12",
    purchasePrice: 6400,
    warrantyExpiration: "2026-08-10",
    warrantyProvider: "Example Home Services",
    status: "needs_attention",
    notes: "Use 16 x 25 filters.",
    schedules: [{
      id: "asset-filter-e2e",
      mode: "scheduled",
      scheduleName: "Replace air filter",
      frequencyType: "months",
      intervalValue: 3,
      lastCompletedDate: "2026-05-01",
      nextDueDate: "2026-08-01",
    }],
    createdAt: "2026-01-20T17:00:00.000Z",
    updatedAt: "2026-07-20T17:00:00.000Z",
  }],
  ["dishwasher", {
    householdId: HOUSEHOLD_ID,
    name: "Kitchen Dishwasher",
    category: "Appliance",
    location: "Kitchen",
    brand: "Bosch",
    model: "E2E 500",
    status: "active",
    notes: "Clean filter monthly.",
    schedules: [{
      id: "dishwasher-filter-e2e",
      mode: "scheduled",
      scheduleName: "Clean filter",
      frequencyType: "months",
      intervalValue: 1,
      nextDueDate: "2026-08-08",
    }],
    createdAt: "2026-03-01T18:00:00.000Z",
    updatedAt: "2026-07-15T18:00:00.000Z",
  }],
];
for (const [id, data] of assets) {
  batch.set(household.collection("home-assets").doc(id), data);
}

batch.set(household.collection("vehicles").doc("family-suv"), {
  householdId: HOUSEHOLD_ID,
  nickname: "Family SUV",
  year: 2021,
  make: "Subaru",
  model: "Outback",
  trim: "Limited",
  vin: "E2E00000000000001",
  licensePlate: "E2E-2026",
  currentMileage: 48750,
  purchaseDate: "2023-04-10",
  purchasePrice: 32500,
  insuranceProvider: "Example Mutual",
  registrationExpiration: "2026-08-12",
  inspectionExpiration: "2026-08-05",
  status: "active",
  notes: "Primary household vehicle.",
  serviceSchedules: [
    {
      id: "tire-rotation-e2e",
      mode: "scheduled",
      serviceName: "Tire rotation",
      intervalMiles: 6000,
      lastCompletedMileage: 43000,
      lastCompletedDate: "2026-04-15",
      nextDueMileage: 49000,
      nextDueDate: "2026-08-15",
    },
    {
      id: "brake-fluid-e2e",
      mode: "scheduled",
      serviceName: "Brake fluid inspection",
      intervalMonths: 24,
      lastCompletedDate: "2024-08-20",
      nextDueDate: "2026-08-20",
    },
  ],
  createdAt: "2026-02-01T17:00:00.000Z",
  updatedAt: "2026-07-30T17:00:00.000Z",
});

const maintenanceLogs = [
  ["oil-change", {
    householdId: HOUSEHOLD_ID,
    targetType: "vehicle",
    vehicleId: "family-suv",
    title: "Engine oil and filter",
    date: "2026-07-12",
    type: "routine",
    notes: "Synthetic oil service completed.",
    cost: 89.5,
    partsUsed: "Oil filter",
    serviceProvider: "Example Auto Care",
    mileage: 47620,
    createdAt: "2026-07-12T16:00:00.000Z",
    updatedAt: "2026-07-12T16:00:00.000Z",
  }],
  ["hvac-inspection", {
    householdId: HOUSEHOLD_ID,
    targetType: "home_asset",
    assetId: "hvac-main",
    title: "Summer HVAC inspection",
    date: "2026-06-20",
    type: "inspection",
    notes: "System operational; filter replacement due soon.",
    cost: 129,
    serviceProvider: "Example Home Services",
    createdAt: "2026-06-20T18:00:00.000Z",
    updatedAt: "2026-06-20T18:00:00.000Z",
  }],
  ["gutter-cleaning", {
    householdId: HOUSEHOLD_ID,
    targetType: "general",
    title: "Clean gutters",
    date: "2026-05-18",
    type: "cleaning",
    notes: "Cleared debris from all downspouts.",
    cost: 0,
    createdAt: "2026-05-18T20:00:00.000Z",
    updatedAt: "2026-05-18T20:00:00.000Z",
  }],
];
for (const [id, data] of maintenanceLogs) {
  batch.set(household.collection("maintenance").doc(id), data);
}
batch.set(household.collection("maintenance-attachments").doc("hvac-report"), {
  householdId: HOUSEHOLD_ID,
  targetType: "maintenance_log",
  targetId: "hvac-inspection",
  category: "invoice",
  fileName: "sample-hvac-report.txt",
  filePath: `households/${HOUSEHOLD_ID}/maintenance/maintenance_log/hvac-inspection/hvac-report-sample-hvac-report.txt`,
  downloadUrl: "/e2e/sample-maintenance-document.txt",
  contentType: "text/plain",
  size: 184,
  uploadedByUid: OWNER.uid,
  uploadedByName: OWNER.displayName,
  createdAt: "2026-06-20T18:05:00.000Z",
});

const notifications = [
  [notificationId("maintenance_asset_schedule", "hvac-main:asset-filter-e2e", "due_today|2026-08-01"), {
    householdId: HOUSEHOLD_ID,
    category: "maintenance",
    title: "HVAC filter due today",
    message: "Replace the Main HVAC System air filter.",
    createdAt: timestamp("2026-08-01T08:00:00.000Z"),
    expiresAt: timestamp("2026-08-08T08:00:00.000Z"),
    deepLink: "/maintenance?asset=hvac-main&schedule=hvac-main%3Aasset-filter-e2e",
    sourceType: "maintenance_asset_schedule",
    sourceId: "hvac-main:asset-filter-e2e",
    stateKey: "due_today|2026-08-01",
    readBy: {},
    dismissedBy: {},
  }],
  ["shopping-read", {
    householdId: HOUSEHOLD_ID,
    category: "shopping",
    title: "Shopping list updated",
    message: "Morgan added two items to Weekly Groceries.",
    createdAt: timestamp("2026-07-31T19:00:00.000Z"),
    expiresAt: timestamp("2026-08-07T19:00:00.000Z"),
    deepLink: "/shopping",
    sourceType: "shopping_list",
    sourceId: "weekly-groceries",
    readBy: {
      [OWNER.uid]: {
        at: timestamp("2026-07-31T19:30:00.000Z"),
        uid: OWNER.uid,
        email: OWNER.email,
        displayName: OWNER.displayName,
      },
    },
    dismissedBy: {},
  }],
  ["system-pending", {
    householdId: HOUSEHOLD_ID,
    category: "system",
    title: "New member needs approval",
    message: "Jamie Pending joined and needs a household role.",
    createdAt: timestamp("2026-07-31T18:00:00.000Z"),
    expiresAt: timestamp("2026-08-07T18:00:00.000Z"),
    deepLink: "/household",
    sourceType: "household_member",
    sourceId: "e2e-pending-uid",
    readBy: {},
    dismissedBy: {},
  }],
  ["dismissed-chore", {
    householdId: HOUSEHOLD_ID,
    category: "chores",
    title: "Chore completed",
    message: "Morgan completed Take bins to curb.",
    createdAt: timestamp("2026-07-30T20:10:00.000Z"),
    expiresAt: timestamp("2026-08-06T20:10:00.000Z"),
    deepLink: "/chores",
    sourceType: "chore",
    sourceId: "chore-completed",
    readBy: {},
    dismissedBy: {
      [OWNER.uid]: {
        at: timestamp("2026-07-30T20:15:00.000Z"),
        uid: OWNER.uid,
        email: OWNER.email,
        displayName: OWNER.displayName,
      },
    },
  }],
];
for (const [id, data] of notifications) {
  batch.set(household.collection("notifications").doc(id), data);
}

await batch.commit();
console.log(`Seeded ${OWNER.email} in ${HOUSEHOLD_ID} for ${PROJECT_ID}.`);

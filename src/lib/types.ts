








export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

export type Recurrence = {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number; // e.g., every 1 week, every 2 weeks
  assignedToEmail: string; // The email of the user this recurrence is assigned to
  dailyOptions?: {
    excludeWeekends: boolean;
  };
  weeklyOptions?: {
    daysOfWeek: number[]; // 0 for Sunday, 1 for Monday, etc.
  };
  monthlyOptions?: {
    dayOfMonth: number; // 1-28
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

export type PantryItem = {
  id: string;
  name: string;
  quantity: number;
  unit: PantryItemUnit;
  location: PantryItemLocation;
  expiryDate?: string | null; // ISO string
};

export type MaintenanceLog = {
  id: string;
  item: string;
  date: string;
  notes: string;
  summary?: string;
  receiptUrl?: string;
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
    assignedToEmail?: string | null;
}

export type Chore = {
  id: string;
  task: string;
  assignedToEmail: string;
  assignedToDisplayName?: string;
  dueDate: string;
  isCompleted: boolean;
  completedAt?: string | null; // ISO String for when the chore was marked as complete
  notes?: string;
  subTasks?: string[];
  completedSubTasks?: string[];
  templateId: string; // To link back to the template
  originalDueDate: string; // To identify which instance of a recurring chore this is
  roomIds?: string[];
};

export type UserRole = 'super-admin' | 'admin' | 'user';

export type HomeAssistantCredentials = {
    url: string;
    accessToken: string;
};

export type BarcodeLibraryItem = {
  id: string; // barcode number
  name: string;
  imageUrl: string;
  createdAt: string; // ISO String
};


export type User = {
  uid: string; // From Firebase Auth
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  forcePasswordChange?: boolean;
  householdId: string | null;
  gender?: string;
  birthday?: string;
  theme?: {
    background?: string;
    accent?: string;
    backgroundHex?: string;
    accentHex?: string;
  } | null;
  choreSettings?: {
    reminderTime: string; // e.g. "17:00"
    reminderEnabled: boolean;
  }
  fcmTokens?: string[];
};

export type Household = {
    id: string;
    name: string;
    ownerEmail: string;
    memberEmails: string[];
    createdAt: string; // ISO string
    inviteCode: string;
}

export type Notification = {
    id: string;
    message: string;
    createdAt: Date;
    isRead: boolean;
    href?: string;
};

export type HomeAssistantEntity = {
    entity_id: string;
    state: string;
    attributes: {
        friendly_name?: string;
        [key: string]: JsonValue | undefined;
    }
}

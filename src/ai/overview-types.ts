export type OverviewSection =
  | 'chores'
  | 'shopping'
  | 'pantry'
  | 'maintenance'
  | 'pets'
  | 'notifications'
  | 'household'
  | 'barcode'
  | 'automation';

export type OverviewUrgentItem = {
  label: string;
  due?: string;
};

export type HomeOverviewFacts = {
  chores?: {
    assignedIncomplete: number;
    overdue: number;
    dueToday: number;
    dueWithinSevenDays: number;
    urgent: OverviewUrgentItem[];
  };
  shopping?: {
    activeLists: number;
    neededItems: number;
    recentlyPurchased: number;
    outstanding: string[];
  };
  pantry?: {
    totalItems: number;
    expired: number;
    expiringWithinSevenDays: number;
    expiringWithinThirtyDays: number;
    nearestExpirations: OverviewUrgentItem[];
  };
  maintenance?: {
    assetsNeedingAttention: number;
    overdue: number;
    dueSoon: number;
    checklistItems: number;
    urgent: OverviewUrgentItem[];
  };
  pets?: { totalPets: number; recentCareEntries: number };
  notifications?: { unread: number; urgent: string[] };
  household?: { activeMembers: number; pendingApprovals: number; activeInvites?: number };
  barcode?: { savedProducts: number };
  automation?: { unavailableEntities: number };
};

export type HomeOverviewNarrative = {
  headline: string;
  summary: string;
  priorities: Array<{
    level: 'urgent' | 'soon' | 'info';
    title: string;
    explanation: string;
    sourceSection: OverviewSection;
  }>;
  sectionSummaries: Partial<Record<OverviewSection, string>>;
};

export type HomeOverviewAiStatus =
  | 'generated'
  | 'configuration_unavailable'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'timeout'
  | 'invalid_response';

export type HomeOverviewResult = {
  generatedAt: string;
  facts: HomeOverviewFacts;
  narrative: HomeOverviewNarrative | null;
  aiStatus: HomeOverviewAiStatus;
};

export const overviewSectionRoutes: Record<OverviewSection, string> = {
  chores: '/chores',
  shopping: '/shopping',
  pantry: '/shopping',
  maintenance: '/maintenance',
  pets: '/pets',
  notifications: '/notifications',
  household: '/household',
  barcode: '/library',
  automation: '/automation',
};

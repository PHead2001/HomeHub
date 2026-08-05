import { z } from 'genkit';

export const OverviewSectionSchema = z.enum([
  'chores',
  'shopping',
  'pantry',
  'maintenance',
  'pets',
  'notifications',
  'household',
  'barcode',
  'automation',
]);

const UrgentItemSchema = z.object({
  label: z.string().trim().min(1).max(100),
  due: z.string().max(32).optional(),
});

export const HomeOverviewFactsSchema = z.object({
  chores: z.object({
    assignedIncomplete: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    dueToday: z.number().int().nonnegative(),
    dueWithinSevenDays: z.number().int().nonnegative(),
    urgent: z.array(UrgentItemSchema).max(5),
  }).optional(),
  shopping: z.object({
    activeLists: z.number().int().nonnegative(),
    neededItems: z.number().int().nonnegative(),
    recentlyPurchased: z.number().int().nonnegative(),
    outstanding: z.array(z.string().trim().min(1).max(100)).max(5),
  }).optional(),
  pantry: z.object({
    totalItems: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    expiringWithinSevenDays: z.number().int().nonnegative(),
    expiringWithinThirtyDays: z.number().int().nonnegative(),
    nearestExpirations: z.array(UrgentItemSchema).max(5),
  }).optional(),
  maintenance: z.object({
    assetsNeedingAttention: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    dueSoon: z.number().int().nonnegative(),
    checklistItems: z.number().int().nonnegative(),
    urgent: z.array(UrgentItemSchema).max(6),
  }).optional(),
  pets: z.object({ totalPets: z.number().int().nonnegative(), recentCareEntries: z.number().int().nonnegative() }).optional(),
  notifications: z.object({
    unread: z.number().int().nonnegative(),
    urgent: z.array(z.string().trim().min(1).max(100)).max(5),
  }).optional(),
  household: z.object({
    activeMembers: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    activeInvites: z.number().int().nonnegative().optional(),
  }).optional(),
  barcode: z.object({ savedProducts: z.number().int().nonnegative() }).optional(),
  automation: z.object({ unavailableEntities: z.number().int().nonnegative() }).optional(),
});

export const HomeOverviewNarrativeSchema = z.object({
  headline: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(500),
  priorities: z.array(z.object({
    level: z.enum(['urgent', 'soon', 'info']),
    title: z.string().trim().min(1).max(100),
    explanation: z.string().trim().min(1).max(240),
    sourceSection: OverviewSectionSchema,
  })).max(6),
  sectionSummaries: z.record(OverviewSectionSchema, z.string().trim().min(1).max(240)).default({}),
});

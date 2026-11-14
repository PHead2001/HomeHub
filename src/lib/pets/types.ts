import type { CareLog, FeedingLog, MedicationLog, Pet } from '../types';

/**
 * Pet-module view of the shared pet types. Every field added here is optional, so
 * documents written before these fields existed still read correctly.
 */

export const PET_SPECIES = ['Dog', 'Cat', 'Bird', 'Fish', 'Small mammal', 'Reptile', 'Other'] as const;
export type PetSpecies = (typeof PET_SPECIES)[number];

export const PORTION_UNITS = ['Cups', 'Cans', 'Scoops', 'Other'] as const;
export type PortionUnit = (typeof PORTION_UNITS)[number];

export const FOOD_TYPES = ['Dry', 'Wet', 'Mix'] as const;
export type FoodType = (typeof FOOD_TYPES)[number];

export type PetProfile = Omit<Pet, 'type'> & {
  /** Older documents hold Dog, Cat or Other; newer ones may hold any `PetSpecies`. */
  type: PetSpecies | string;
  /** Planned feedings per day (drives the feeding ring). Falls back to parsing `foodSchedule`. */
  feedingsPerDay?: number;
  /** Usual portion, used by one-tap feeding. Falls back to parsing `foodSchedule`. */
  portionAmount?: number;
  portionUnit?: PortionUnit;
  /**
   * The confirmed meal plan (PE-22a): structured slots with stable ids. Absent on
   * pets whose schedule was never confirmed; they keep the legacy daily target
   * (`feedingsPerDay` or the parsed schedule) until a member confirms one.
   */
  mealPlan?: MealPlan;
  /** Plans that applied before the current one, oldest first (PE-22g; at most `MEAL_PLAN_HISTORY_MAX`). */
  mealPlanHistory?: MealPlanHistoryEntry[];
};

/** One meal of the day (PE-22a). `id` never changes when the meal is renamed or moved. */
export type MealSlot = {
  id: string;
  /** "Breakfast", "Dinner" (1-30 characters). */
  name: string;
  /** Household-local time of day, `HH:mm`. */
  time: string;
  /** Portion for this meal, above 0 and at most 50. */
  amount: number;
  unit: PortionUnit;
  /** Weekdays (0 = Sunday … 6 = Saturday, household calendar) this meal is not served. */
  offDays?: number[];
};

/** A confirmed meal plan. It applies from `effectiveFrom` (a household day) on. */
export type MealPlan = {
  slots: MealSlot[];
  /** Household day (`yyyy-MM-dd`) from which this plan applies; earlier days use `mealPlanHistory`. */
  effectiveFrom: string;
  /** Server time of the confirmation (rules: `request.time`). */
  confirmedAt?: unknown;
  /** The member who confirmed it (rules: the writer). */
  confirmedByUid?: string;
  confirmedByName?: string;
};

/**
 * A plan that applied on the days before `until` (and after the previous
 * entry's `until`): confirmed slots, or the legacy daily target (`perDay`,
 * `nonDaily`) the pet had before its first confirmed plan.
 */
export type MealPlanHistoryEntry = {
  until: string;
  slots?: MealSlot[];
  perDay?: number | null;
  nonDaily?: boolean;
};

/** Who wrote a log entry. Missing on entries written before this field existed. */
export type LoggedBy = {
  loggedByUid?: string;
  loggedByName?: string;
};

export type PetFeedingLog = FeedingLog & LoggedBy & {
  /** Server time the entry was written (shared feed operation); the author may delete it for 10 minutes after. */
  loggedAt?: unknown;
  /** `none`: no recent feed; `confirmed`: logged after "Feed again?"; `offline`: queued offline, nobody else's feed could be checked. */
  repeat?: 'none' | 'confirmed' | 'offline';
  /** `device`: `date` is this device's clock (offline); otherwise it is server time or a chosen time. */
  clockSource?: 'device' | 'server';
  /** A deliberately chosen past time from the detailed form. */
  backdated?: boolean;
  /** With `repeat: 'confirmed'`: the last feeding's log the member was asked about ("Feed again?", PE-23g). */
  confirmOf?: string | null;
  /** The meal slot this feeding was for (PE-22c); absent on older, offline and backdated entries (assigned by time). */
  slotId?: string;
  /** The effective time before its first correction (PE-5e); `date` is the corrected time. */
  originalDate?: unknown;
  /** Server time of the latest correction of `date`, and who made it. */
  dateCorrectedAt?: unknown;
  dateCorrectedByUid?: string;
  dateCorrectedByName?: string;
};

export type PetMedicationLog = MedicationLog & LoggedBy & {
  /** Next dose due, as a local calendar date `yyyy-MM-dd`. */
  nextDueDate?: string;
};

export type PetCareLog = CareLog & LoggedBy;

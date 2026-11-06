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
};

/** Who wrote a log entry. Missing on entries written before this field existed. */
export type LoggedBy = {
  loggedByUid?: string;
  loggedByName?: string;
};

export type PetFeedingLog = FeedingLog & LoggedBy;

export type PetMedicationLog = MedicationLog & LoggedBy & {
  /** Next dose due, as a local calendar date `yyyy-MM-dd`. */
  nextDueDate?: string;
};

export type PetCareLog = CareLog & LoggedBy;

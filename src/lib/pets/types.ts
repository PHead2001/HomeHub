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

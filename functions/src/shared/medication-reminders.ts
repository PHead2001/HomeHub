// Pet medication reminders, computed on the server by hourly upkeep. Pure (no
// Firebase imports) so they can be unit-tested.
//
// Same rule as the Pets module's countdown (`nextMedication` over
// `useMedicationCountdownLogs` / `pendingWindowStart` in src/lib/pets/care.ts):
// medications are grouped by trimmed, lower-cased name; the most recent entry
// of each medication decides its next due date, so a later dose logged
// without a next due date cancels the countdown. Entries without a readable
// date are ignored (the Pets window never loads them as the latest dose).
import {isDayString} from "./calendar";

export const MEDICATION_SOURCE_TYPE = "pet_medication";

export type MedicationLogInput = {
  date?: unknown;
  medication?: unknown;
  nextDueDate?: unknown;
};

export type PetInput = {
  id: string;
  name?: unknown;
  logs: MedicationLogInput[];
};

export type MedicationDue = {
  /** Trimmed, lower-cased medication name (the grouping key). */
  key: string;
  /** The name as written on the latest entry. */
  medication: string;
  /** Next due day, yyyy-MM-dd. */
  dueDay: string;
};

export type MedicationReminder = {
  sourceType: typeof MEDICATION_SOURCE_TYPE;
  sourceId: string;
  stateKey: string;
  state: "due" | "overdue";
  title: string;
  message: string;
  deepLink: string;
};

/**
 * A real yyyy-MM-dd calendar day (rejects rollovers such as Feb 30, as the
 * Pets page's parseLocalDate does).
 * @param {unknown} value Candidate.
 * @return {boolean} True for a valid day string.
 */
const isDueDay = (value: unknown): value is string =>
  isDayString(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const toMillis = (value: unknown): number | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (value && typeof value === "object" &&
      typeof (value as {toDate?: unknown}).toDate === "function") {
    return toMillis((value as {toDate: () => Date}).toDate());
  }
  return null;
};

/**
 * Pending countdowns for one pet: one entry per medication whose latest dose
 * carries a valid next due date.
 * @param {MedicationLogInput[]} logs Every medication entry of the pet.
 * @return {MedicationDue[]} Pending countdowns.
 */
export const pendingMedications = (
  logs: MedicationLogInput[],
): MedicationDue[] => {
  const latest = new Map<string, {at: number; log: MedicationLogInput}>();
  for (const log of logs) {
    const name = typeof log.medication === "string" ?
      log.medication.trim() : "";
    const key = name.toLowerCase();
    const at = toMillis(log.date);
    if (!key || at === null) continue;
    const current = latest.get(key);
    if (!current || at > current.at) latest.set(key, {at, log});
  }
  const pending: MedicationDue[] = [];
  for (const [key, {log}] of latest) {
    if (!isDueDay(log.nextDueDate)) continue;
    pending.push({
      key,
      medication: String(log.medication).trim(),
      dueDay: log.nextDueDate,
    });
  }
  return pending;
};

const petName = (pet: PetInput): string =>
  typeof pet.name === "string" && pet.name.trim() ?
    pet.name.trim().slice(0, 40) : "Your pet";

/**
 * Reminders for medications due today or overdue (in the household's day).
 * @param {PetInput[]} pets Pets with their medication entries.
 * @param {string} today Household-local day, yyyy-MM-dd.
 * @return {MedicationReminder[]} One reminder per actionable countdown.
 */
export const buildMedicationReminders = (
  pets: PetInput[],
  today: string,
): MedicationReminder[] => pets.flatMap((pet) =>
  pendingMedications(pet.logs)
    .filter((due) => due.dueDay <= today)
    .map((due): MedicationReminder => {
      const state = due.dueDay === today ? "due" : "overdue";
      const name = petName(pet);
      const medication = due.medication.slice(0, 60);
      return {
        sourceType: MEDICATION_SOURCE_TYPE,
        sourceId: `${pet.id}:${due.key}`,
        stateKey: `${state}|${due.dueDay}`,
        state,
        title: state === "due" ?
          `${name}'s ${medication} is due today` :
          `${name}'s ${medication} is overdue`,
        message: `Log the dose on ${name}'s Medication tab once it's given.`,
        deepLink: `/pets/${encodeURIComponent(pet.id)}?tab=medication`,
      };
    }));

/**
 * The countdown a reminder belongs to: the medication and its due day. A
 * reminder stays open while that countdown is still pending (due turning
 * overdue is the same countdown) and resolves once it is not.
 * @param {string} sourceId `<petId>:<medicationKey>`.
 * @param {string} stateKey `<due|overdue>|<yyyy-MM-dd>`.
 * @return {string} Countdown identity.
 */
export const medicationCycle = (sourceId: string, stateKey: string): string =>
  `${sourceId}|${stateKey.split("|")[1] ?? ""}`;

/**
 * Countdown identities that are still pending (due or not yet due).
 * @param {PetInput[]} pets Pets with their medication entries.
 * @return {Set<string>} Identities, as from medicationCycle.
 */
export const pendingCycles = (pets: PetInput[]): Set<string> =>
  new Set(pets.flatMap((pet) => pendingMedications(pet.logs)
    .map((due) => `${pet.id}:${due.key}|${due.dueDay}`)));

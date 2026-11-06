// Maintenance reminder rules shared by the Maintenance page and the scheduled
// Cloud Function. Pure: callers pass "today" in the household's timezone.
import {diffDays, toDay} from "./calendar";
import {stableSlugify} from "./ids";

export const REMINDER_DUE_SOON_DAYS = 14;
export const MILEAGE_DUE_SOON_THRESHOLD = 500;

export type ReminderStatus = "upcoming" | "due_soon" | "due_today" | "overdue";
export type ReminderGroup =
  "scheduled" | "warranty" | "vehicle_service" | "vehicle_document";

type Schedule = {
  id?: string;
  mode?: "scheduled" | "checklist";
  scheduleName?: string;
  serviceName?: string;
  frequencyType?: string;
  intervalValue?: number;
  intervalMiles?: number;
  intervalMonths?: number;
  nextDueDate?: string;
  nextDueMileage?: number;
  /**
   * Set by "Snooze" to the due date it moved the schedule to. While it
   * equals nextDueDate and that day has not come, the upcoming or due-soon
   * reminder is snoozed: no notification. Completing or editing changes
   * nextDueDate, so a stale value never applies.
   */
  snoozedUntil?: string;
};

export type AssetInput = {
  id: string;
  name: string;
  status?: string;
  schedules?: Schedule[];
  warrantyExpiration?: string;
};

export type VehicleInput = {
  id: string;
  nickname: string;
  status?: string;
  currentMileage?: number;
  serviceSchedules?: Schedule[];
  registrationExpiration?: string;
  inspectionExpiration?: string;
};

export type MaintenanceReminder = {
  id: string;
  group: ReminderGroup;
  status: ReminderStatus;
  title: string;
  relatedName: string;
  targetType: "home_asset" | "vehicle";
  targetId: string;
  sourceType: string;
  sourceId: string;
  stateKey: string;
  scheduleKey?: string;
  legacySourceId?: string;
  dueDate?: string;
  dueMileage?: number;
  currentMileage?: number;
  /** Snoozed by a member until its due date: shown, but not notified. */
  snoozed?: boolean;
  message: string;
  deepLink: string;
};

const isScheduled = (s: Schedule, vehicle: boolean): boolean => {
  if (s.mode) return s.mode === "scheduled";
  return vehicle ?
    Boolean(s.intervalMiles || s.intervalMonths || s.nextDueMileage ||
      s.nextDueDate) :
    Boolean((s.frequencyType && s.intervalValue) || s.nextDueDate);
};

export const dateStatus = (
  date: string | undefined,
  today: string,
  timeZone: string,
): ReminderStatus | null => {
  const due = toDay(date, timeZone);
  if (!due) return null;
  const days = diffDays(due, today);
  if (days < 0) return "overdue";
  if (days === 0) return "due_today";
  return days <= REMINDER_DUE_SOON_DAYS ? "due_soon" : "upcoming";
};

export const mileageStatus = (
  nextDue?: number,
  current?: number,
): ReminderStatus | null => {
  if (typeof nextDue !== "number" || typeof current !== "number") return null;
  if (current >= nextDue) return "overdue";
  return nextDue - current <= MILEAGE_DUE_SOON_THRESHOLD ?
    "due_soon" : "upcoming";
};

const phrase: Record<ReminderStatus, string> = {
  overdue: "is overdue",
  due_today: "is due today",
  due_soon: "is due soon",
  upcoming: "is coming up",
};

const expiryPhrase: Record<ReminderStatus, string> = {
  overdue: "has expired",
  due_today: "expires today",
  due_soon: "expires soon",
  upcoming: "expires later",
};

const legacyKey = (index: number, title: string) =>
  `legacy-${index}-${stableSlugify(title)}`;

const isSnoozed = (schedule: Schedule, status: ReminderStatus): boolean =>
  Boolean(schedule.snoozedUntil) &&
  schedule.snoozedUntil === schedule.nextDueDate &&
  (status === "upcoming" || status === "due_soon");

/**
 * Builds every maintenance reminder for a household, most urgent first.
 * Retired assets and retired/sold vehicles produce none.
 * @param {AssetInput[]} assets Home assets.
 * @param {VehicleInput[]} vehicles Vehicles.
 * @param {string} today Today in the household timezone.
 * @param {string} timeZone Household timezone.
 * @return {MaintenanceReminder[]} Reminders.
 */
export const buildMaintenanceReminders = (
  assets: AssetInput[],
  vehicles: VehicleInput[],
  today: string,
  timeZone: string,
): MaintenanceReminder[] => {
  const reminders: MaintenanceReminder[] = [];

  assets.filter((a) => a.status !== "retired").forEach((asset) => {
    (asset.schedules || []).forEach((schedule, index) => {
      if (!isScheduled(schedule, false)) return;
      const status = dateStatus(schedule.nextDueDate, today, timeZone);
      if (!status) return;
      const title = schedule.scheduleName || "Scheduled maintenance";
      const sourceId =
        `${asset.id}:${schedule.id || legacyKey(index, title)}`;
      reminders.push({
        id: `asset-schedule-${asset.id}-${index}-${status}`,
        group: "scheduled",
        status,
        title,
        relatedName: asset.name,
        targetType: "home_asset",
        targetId: asset.id,
        sourceType: "maintenance_asset_schedule",
        sourceId,
        stateKey: `${status}|${schedule.nextDueDate || "no-date"}`,
        scheduleKey: sourceId,
        legacySourceId: `${asset.id}-${index}`,
        dueDate: schedule.nextDueDate,
        snoozed: isSnoozed(schedule, status),
        message: `${title} for ${asset.name} ${phrase[status]}.`,
        deepLink: `/maintenance?asset=${encodeURIComponent(asset.id)}` +
          `&schedule=${encodeURIComponent(sourceId)}`,
      });
    });

    const warranty = dateStatus(asset.warrantyExpiration, today, timeZone);
    if (warranty && warranty !== "upcoming") {
      reminders.push({
        id: `asset-warranty-${asset.id}-${warranty}`,
        group: "warranty",
        status: warranty,
        title: "Warranty",
        relatedName: asset.name,
        targetType: "home_asset",
        targetId: asset.id,
        sourceType: "maintenance_asset_warranty",
        sourceId: asset.id,
        stateKey: `${warranty}|${asset.warrantyExpiration || "no-date"}`,
        dueDate: asset.warrantyExpiration,
        message: `The ${asset.name} warranty ${expiryPhrase[warranty]}.`,
        deepLink: `/maintenance?asset=${encodeURIComponent(asset.id)}`,
      });
    }
  });

  vehicles.filter((v) => v.status !== "retired" && v.status !== "sold")
    .forEach((vehicle) => {
      (vehicle.serviceSchedules || []).forEach((schedule, index) => {
        if (!isScheduled(schedule, true)) return;
        const byDate = dateStatus(schedule.nextDueDate, today, timeZone);
        const byMiles =
          mileageStatus(schedule.nextDueMileage, vehicle.currentMileage);
        const status: ReminderStatus | null =
          byDate === "overdue" || byMiles === "overdue" ? "overdue" :
            byDate === "due_today" ? "due_today" :
              byDate === "due_soon" || byMiles === "due_soon" ? "due_soon" :
                byDate || byMiles;
        if (!status) return;
        const title = schedule.serviceName || "Scheduled service";
        const sourceId =
          `${vehicle.id}:${schedule.id || legacyKey(index, title)}`;
        reminders.push({
          id: `vehicle-service-${vehicle.id}-${index}-${status}`,
          group: "vehicle_service",
          status,
          title,
          relatedName: vehicle.nickname,
          targetType: "vehicle",
          targetId: vehicle.id,
          sourceType: "maintenance_vehicle_service",
          sourceId,
          stateKey: `${status}|${schedule.nextDueDate || "no-date"}|` +
            `${schedule.nextDueMileage ?? "no-mileage"}`,
          scheduleKey: sourceId,
          legacySourceId: `${vehicle.id}-${index}`,
          dueDate: schedule.nextDueDate,
          dueMileage: schedule.nextDueMileage,
          // A snooze only quiets the date; a mileage trigger still notifies.
          snoozed: (byMiles === null || byMiles === "upcoming") &&
            isSnoozed(schedule, status),
          currentMileage: vehicle.currentMileage,
          message: `${title} for ${vehicle.nickname} ${phrase[status]}.`,
          deepLink:
            `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}` +
            `&schedule=${encodeURIComponent(sourceId)}`,
        });
      });

      const documents: Array<[string, string | undefined, string]> = [
        ["Registration", vehicle.registrationExpiration,
          "maintenance_vehicle_registration"],
        ["Inspection", vehicle.inspectionExpiration,
          "maintenance_vehicle_inspection"],
      ];
      documents.forEach(([title, due, sourceType]) => {
        const status = dateStatus(due, today, timeZone);
        if (!status || status === "upcoming") return;
        reminders.push({
          id: `${sourceType}-${vehicle.id}-${status}`,
          group: "vehicle_document",
          status,
          title: `Vehicle ${title.toLowerCase()}`,
          relatedName: vehicle.nickname,
          targetType: "vehicle",
          targetId: vehicle.id,
          sourceType,
          sourceId: vehicle.id,
          stateKey: `${status}|${due || "no-date"}`,
          dueDate: due,
          message:
            `${title} for ${vehicle.nickname} ${expiryPhrase[status]}.`,
          deepLink: `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}`,
        });
      });
    });

  const weight: Record<ReminderStatus, number> =
    {overdue: 0, due_today: 1, due_soon: 2, upcoming: 3};
  return reminders.sort((a, b) =>
    weight[a.status] - weight[b.status] ||
    (a.dueDate || "").localeCompare(b.dueDate || ""));
};

/**
 * Reminders worth notifying about (overdue, due today, due soon).
 * @param {MaintenanceReminder[]} reminders All reminders.
 * @return {MaintenanceReminder[]} Actionable reminders.
 */
export const actionableReminders = (
  reminders: MaintenanceReminder[],
): MaintenanceReminder[] =>
  reminders.filter((r) => r.status !== "upcoming" && !r.snoozed);

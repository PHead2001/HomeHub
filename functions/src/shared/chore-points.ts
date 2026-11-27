// Chore points (H06), the one rule shared by the Chores page, the dashboard
// and server upkeep (the weekly podium snapshot, CH-29). Pure.
//
// - A completed chore is worth POINTS.base, plus POINTS.perSubTask a step,
//   plus POINTS.onTime when completed on or before its due day.
// - Points go to whoever completed it (D-7, `creditedUid`).
// - Self-made chores earn nothing (CH-20): a one-time chore created by the
//   person who completed it. Generated days of a repeating chore, chores from
//   the library and chores someone else added always count; chores written
//   before `createdByUid` existed count too (nothing says who made them).
// - Each person earns at most DAILY_POINT_CAP points a day (CH-20), the day
//   being the completion's day in the household's time zone.
import {resolveAssigneeUid, type AssigneeRecord} from "./assignee";
import {addDays, dayOfWeek, isDayString} from "./calendar";
import {choreCompletionInstant, type CompletionFields} from "./completion";

export const POINTS = {
  /** Every completed chore. */
  base: 10,
  /** Each sub-task on the chore (bigger chores are worth more). */
  perSubTask: 2,
  /** Completed on or before the day it was due. */
  onTime: 5,
} as const;

/** Most points one person earns in one day (CH-20). */
export const DAILY_POINT_CAP = 100;

/** Highest allowance rate an owner can set, in cents per point (CH-29). */
export const MAX_CENTS_PER_POINT = 100;

/** The day ("YYYY-MM-DD") of an instant, in the reader's time zone. */
export type DayOf = (instant: Date) => string;

export type PointsChore = CompletionFields & AssigneeRecord & {
  subTasks?: unknown;
  originalDueDate?: unknown;
  dueDate?: unknown;
  templateId?: unknown;
  sourceType?: unknown;
  createdByUid?: unknown;
  completedByUid?: unknown;
  completedByEmail?: unknown;
};

/** A household member for points: uid, label and (where known) email. */
export type PointsMember = {
  uid: string;
  name?: string;
  role?: string;
  email?: string | null;
};

const lower = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * The day a chore is due: `originalDueDate` when it is a day string, else
 * `dueDate` when it is one, else `dueDate` read as an instant.
 * @param {PointsChore} chore Chore fields.
 * @param {DayOf} dayOf Day of an instant.
 * @return {string} Day, or "" when it has none.
 */
export const pointsDueDay = (chore: PointsChore, dayOf: DayOf): string => {
  if (isDayString(chore.originalDueDate)) return chore.originalDueDate;
  if (isDayString(chore.dueDate)) return chore.dueDate;
  if (typeof chore.dueDate !== "string") return "";
  const parsed = new Date(chore.dueDate);
  return Number.isNaN(parsed.getTime()) ? "" : dayOf(parsed);
};

/**
 * Points for one completed chore, before the daily cap (0 when open).
 * @param {PointsChore} chore Chore fields.
 * @param {DayOf} dayOf Day of an instant.
 * @return {number} Points.
 */
export const choreBasePoints = (chore: PointsChore, dayOf: DayOf): number => {
  const completed = choreCompletionInstant(chore);
  if (!completed) return 0;
  const steps = Array.isArray(chore.subTasks) ? chore.subTasks.length : 0;
  const due = pointsDueDay(chore, dayOf);
  const onTime = due !== "" && dayOf(completed) <= due;
  return POINTS.base + steps * POINTS.perSubTask +
    (onTime ? POINTS.onTime : 0);
};

/**
 * Whether a completed chore earns points for `completerUid` (CH-20): every
 * chore except a one-time chore its completer created for themselves.
 * @param {PointsChore} chore Chore fields.
 * @param {string} completerUid Who gets the credit.
 * @return {boolean} True when it earns points.
 */
export const earnsPoints = (
  chore: PointsChore,
  completerUid: string,
): boolean => {
  const generated = typeof chore.templateId === "string" &&
    chore.templateId !== "" &&
    (chore.sourceType === undefined || chore.sourceType === null);
  if (generated || chore.sourceType === "template") return true;
  const creator = typeof chore.createdByUid === "string" ?
    chore.createdByUid.trim() : "";
  return creator === "" || creator !== completerUid;
};

/**
 * Who a completed chore's points go to (D-7, CH-12): the member who
 * completed it (`completedByUid`, else `completedByEmail`, written by the
 * server), else its assignee (`resolveAssigneeUid`: uid or email) for
 * completions recorded before attribution existed. Returns the member's
 * uid, or null when the credited person is not among `members`.
 * @param {PointsChore} chore Chore fields.
 * @param {PointsMember[]} members Household members.
 * @return {string | null} Credited uid.
 */
export const creditedUid = (
  chore: PointsChore,
  members: readonly Pick<PointsMember, "uid" | "email">[],
): string | null => {
  if (typeof chore.completedByUid === "string" && chore.completedByUid) {
    const member = members.find((m) => m.uid === chore.completedByUid);
    if (member) return member.uid;
  }
  const completer = lower(chore.completedByEmail);
  if (completer) {
    const member = members.find((m) => lower(m.email) === completer);
    return member ? member.uid : null;
  }
  // A recorded completer who is no longer a member gets nothing.
  if (typeof chore.completedByUid === "string" && chore.completedByUid) {
    return null;
  }
  return resolveAssigneeUid(chore, members);
};

/** One person's completions on one day. */
export type PointsDay = {
  /** Points before the daily cap. */
  raw: number;
  /** Every chore completed that day. */
  completed: number;
  /** Completed chores that earned points (stickers for child accounts). */
  earning: number;
};

/**
 * Each member's completions by day (household day of the completion), for
 * days up to `today`; completions credited to non-members are ignored.
 * @param {PointsChore[]} chores Chores (open ones are skipped).
 * @param {PointsMember[]} members Household members.
 * @param {DayOf} dayOf Day of an instant.
 * @param {string} today Household day; later completions are ignored.
 * @return {Map<string, Map<string, PointsDay>>} By uid, then day.
 */
export const pointsLedger = (
  chores: readonly PointsChore[],
  members: readonly PointsMember[],
  dayOf: DayOf,
  today: string,
): Map<string, Map<string, PointsDay>> => {
  const ledger = new Map(members.map((m) =>
    [m.uid, new Map<string, PointsDay>()]));
  for (const chore of chores) {
    const completed = choreCompletionInstant(chore);
    if (!completed) continue;
    const uid = creditedUid(chore, members);
    const days = uid ? ledger.get(uid) : undefined;
    if (!uid || !days) continue;
    const day = dayOf(completed);
    if (day > today) continue; // clock skew: never count the future
    const entry = days.get(day) ?? {raw: 0, completed: 0, earning: 0};
    entry.completed += 1;
    if (earnsPoints(chore, uid)) {
      entry.raw += choreBasePoints(chore, dayOf);
      entry.earning += 1;
    }
    days.set(day, entry);
  }
  return ledger;
};

/**
 * Points for one day after the daily cap.
 * @param {PointsDay | undefined} day The day's completions.
 * @return {number} Capped points.
 */
export const cappedDayPoints = (day: PointsDay | undefined): number =>
  Math.min(day?.raw ?? 0, DAILY_POINT_CAP);

/**
 * Monday of the week containing `day`.
 * @param {string} day Day string.
 * @return {string} Monday.
 */
export const weekStartDay = (day: string): string =>
  addDays(day, -((dayOfWeek(day) + 6) % 7));

/**
 * A stored allowance rate, read defensively (0 when unset or invalid).
 * @param {unknown} data Chore preferences document data.
 * @return {number} Whole cents per point.
 */
export const centsPerPointFrom = (data: unknown): number => {
  const value = data && typeof data === "object" ?
    (data as Record<string, unknown>).centsPerPoint : undefined;
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= MAX_CENTS_PER_POINT ? value : 0;
};

/** One person's result for a closed week. */
export type WeekMemberResult = {
  uid: string;
  name: string;
  /** Child accounts collect stickers on the page; they are paid the same. */
  stickerMode: boolean;
  points: number;
  completed: number;
  /** points x centsPerPoint. */
  payoutCents: number;
};

/** A closed week's results (Monday to Sunday), as upkeep snapshots them. */
export type WeekSummary = {
  weekStart: string;
  weekEnd: string;
  centsPerPoint: number;
  /** Members who earned points, best first. */
  members: WeekMemberResult[];
};

/**
 * Document id of a closed week's snapshot under households/{id}/stats.
 * @param {string} weekStart Monday of the week.
 * @return {string} Document id.
 */
export const weekSnapshotDocId = (weekStart: string): string =>
  `week-${weekStart}`;

const label = (value: unknown): string => {
  const name = typeof value === "string" ? value.trim() : "";
  return name && !name.includes("@") ? name.slice(0, 200) : "Member";
};

/**
 * The results of the week starting `weekStart`: each member's capped
 * points, completions and payout at `centsPerPoint`, best first. Members
 * with no points are left out.
 * @param {PointsChore[]} chores Retained chores.
 * @param {PointsMember[]} members Household members.
 * @param {string} weekStart Monday of the week.
 * @param {DayOf} dayOf Day of an instant (household time zone).
 * @param {number} centsPerPoint Allowance rate.
 * @return {WeekSummary} The week's results.
 */
export const weekSummary = (
  chores: readonly PointsChore[],
  members: readonly PointsMember[],
  weekStart: string,
  dayOf: DayOf,
  centsPerPoint: number,
): WeekSummary => {
  const weekEnd = addDays(weekStart, 6);
  const ledger = pointsLedger(chores, members, dayOf, weekEnd);
  const rate = centsPerPointFrom({centsPerPoint});
  const results: WeekMemberResult[] = [];
  for (const member of members) {
    let points = 0;
    let completed = 0;
    for (let day = weekStart; day <= weekEnd; day = addDays(day, 1)) {
      const entry = ledger.get(member.uid)?.get(day);
      points += cappedDayPoints(entry);
      completed += entry?.completed ?? 0;
    }
    if (points <= 0) continue;
    results.push({
      uid: member.uid,
      name: label(member.name),
      stickerMode: member.role === "child",
      points,
      completed,
      payoutCents: points * rate,
    });
  }
  results.sort((a, b) => b.points - a.points ||
    b.completed - a.completed || a.name.localeCompare(b.name));
  return {weekStart, weekEnd, centsPerPoint: rate, members: results};
};

/**
 * A stored week snapshot, read defensively; null when it is not one.
 * @param {unknown} data Stored document data.
 * @return {WeekSummary | null} The summary.
 */
export const readWeekSummary = (data: unknown): WeekSummary | null => {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (!isDayString(raw.weekStart) || !isDayString(raw.weekEnd)) return null;
  const list = Array.isArray(raw.members) ? raw.members : [];
  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value : 0;
  const members = list.flatMap((item): WeekMemberResult[] => {
    if (!item || typeof item !== "object") return [];
    const m = item as Record<string, unknown>;
    if (typeof m.uid !== "string" || !m.uid) return [];
    return [{
      uid: m.uid,
      name: label(m.name),
      stickerMode: m.stickerMode === true,
      points: number(m.points),
      completed: number(m.completed),
      payoutCents: number(m.payoutCents),
    }];
  });
  return {
    weekStart: raw.weekStart,
    weekEnd: raw.weekEnd,
    centsPerPoint: centsPerPointFrom(raw),
    members,
  };
};

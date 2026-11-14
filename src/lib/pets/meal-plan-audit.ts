/**
 * What a pet needs before it has confirmed meal slots (PE-22i, D-P8 spirit), for
 * the read-only audit `scripts/ops/audit-meal-plans.mjs`. Nothing is converted:
 * the only way a pet gets slots is a member confirming them in the app; this
 * only sorts pets into what that confirmation will look like. Pure.
 */
import { readMealPlan } from './meal-plan';
import { parseSchedule } from './schedule-parser';

export type MealPlanAuditKind =
  /** Has a valid confirmed plan. */
  | 'confirmed'
  /** Has a plan field that cannot be read: it is treated as no plan; re-confirm in the app. */
  | 'malformed-plan'
  /** The schedule states clock times: the form suggests them for confirmation. */
  | 'suggest-times'
  /** The schedule names parts of the day: suggested with default times to check. */
  | 'suggest-parts'
  /** The schedule only states a count ("twice daily"): suggested with default times to pick. */
  | 'suggest-count'
  /** No readable schedule, but a structured feedings-per-day: times must be picked. */
  | 'structured-count'
  /** The structured feedings-per-day disagrees with the meals the schedule names. */
  | 'count-conflict'
  /** The schedule cannot be read as one set of meals: no suggestion, set by hand. */
  | 'ambiguous'
  /** Not a daily schedule: keeps its legacy behaviour; slots only if meals have fixed times. */
  | 'non-daily'
  /** No schedule text and no structured count. */
  | 'no-schedule';

export const MEAL_PLAN_AUDIT_NEEDS: Record<MealPlanAuditKind, string> = {
  confirmed: 'nothing',
  'malformed-plan': 're-confirm meal times in the app (the stored plan is unreadable and ignored)',
  'suggest-times': 'confirm the suggested times in the app',
  'suggest-parts': 'check the guessed times, then confirm in the app',
  'suggest-count': 'pick a time for each meal, then confirm in the app',
  'structured-count': 'pick a time for each meal (no schedule text to read)',
  'count-conflict': 'decide how many meals, then set times by hand',
  ambiguous: 'set times by hand (the schedule gives no suggestion)',
  'non-daily': 'nothing required (keeps its legacy count); set times only if the meals are at fixed times',
  'no-schedule': 'set times by hand',
};

export function auditPetMealPlan(pet: { mealPlan?: unknown; foodSchedule?: unknown; feedingsPerDay?: unknown }): MealPlanAuditKind {
  if (pet.mealPlan !== undefined && pet.mealPlan !== null) return readMealPlan(pet) ? 'confirmed' : 'malformed-plan';
  const schedule = typeof pet.foodSchedule === 'string' ? pet.foodSchedule : '';
  const structured = typeof pet.feedingsPerDay === 'number' && Number.isInteger(pet.feedingsPerDay) && pet.feedingsPerDay > 0 ? pet.feedingsPerDay : null;
  const parsed = parseSchedule(schedule);
  if (parsed.kind === 'nonDaily') return structured ? 'count-conflict' : 'non-daily';
  if (parsed.kind === 'ambiguous') return 'ambiguous';
  if (parsed.kind === 'empty') return structured ? 'structured-count' : 'no-schedule';
  if (structured !== null && structured !== parsed.perDay) return 'count-conflict';
  if (parsed.meals.some((meal) => meal.source === 'count')) return 'suggest-count';
  return parsed.meals.some((meal) => meal.source === 'part') ? 'suggest-parts' : 'suggest-times';
}

// Actionable pushes (NO-23), the simplest safe version: each action only
// opens an in-app link that already does the job (Give dose opens the dose
// dialog for that course; a maintenance reminder opens its schedule with Done
// and Snooze; overdue chores open the overdue list). Nothing is written from
// the service worker, so an action never acts without the app's own checks.
// Pure: the push function sends the result as `webpush.data.actions` (JSON)
// and the worker re-checks every field and link.
import {safePushLink} from "./push-link";

export type PushAction = {action: string; title: string; link: string};

/** At most this many buttons (browsers show two). */
export const MAX_PUSH_ACTIONS = 2;

const MAINTENANCE = /^maintenance_/;

/**
 * The action buttons for a notification, or none.
 * @param {Record<string, unknown>} data The notification document.
 * @return {PushAction[]} Up to MAX_PUSH_ACTIONS actions with safe links.
 */
export const pushActionsFor = (
  data: Record<string, unknown>,
): PushAction[] => {
  const link = safePushLink(data.deepLink);
  if (link === "/") return [];
  const sourceType = typeof data.sourceType === "string" ? data.sourceType : "";
  const actions: PushAction[] = [];
  if (sourceType === "pet_medication" && link.includes("dose=")) {
    actions.push({action: "dose", title: "Give dose", link});
  } else if (MAINTENANCE.test(sourceType)) {
    actions.push({action: "schedule", title: "Done or snooze", link});
  } else if (sourceType === "chore-reminder" && data.sourceId === "overdue") {
    actions.push({action: "overdue", title: "See overdue", link});
  }
  return actions.slice(0, MAX_PUSH_ACTIONS);
};

// Who may see a notification of a given category, shared by the push sender
// and the web app's bell, center and dashboard tile so all of them agree.
// Pure (no Firebase imports). Categories that belong to a module need that
// module's view permission; `system` and `general` need none.

export type ViewPermission =
  | "chores.view"
  | "pets.view"
  | "shopping.view"
  | "maintenance.view"
  | "automation.view";

const CATEGORY_VIEW_PERMISSION: Record<string, ViewPermission> = {
  chores: "chores.view",
  pets: "pets.view",
  shopping: "shopping.view",
  maintenance: "maintenance.view",
  automation: "automation.view",
};

/**
 * The view permission a notification category requires, if any.
 * @param {unknown} category Notification category.
 * @return {ViewPermission | null} Required permission, or null.
 */
export const categoryViewPermission = (
  category: unknown,
): ViewPermission | null =>
  typeof category === "string" &&
  Object.prototype.hasOwnProperty.call(CATEGORY_VIEW_PERMISSION, category) ?
    CATEGORY_VIEW_PERMISSION[category] : null;

/**
 * Whether someone with the given permission check may see a category.
 * @param {unknown} category Notification category.
 * @param {Function} can Answers whether the viewer holds a permission.
 * @return {boolean} True when visible.
 */
export const canSeeCategory = (
  category: unknown,
  can: (permission: ViewPermission) => boolean,
): boolean => {
  const permission = categoryViewPermission(category);
  return permission === null || can(permission);
};

// Role defaults, as in firestore.rules `roleHasPermission` and the web app's
// getRolePresetPermissions.
const ROLE_VIEW: Record<string, ViewPermission[]> = {
  admin: [
    "chores.view", "pets.view", "shopping.view", "maintenance.view",
    "automation.view",
  ],
  member: [
    "chores.view", "pets.view", "shopping.view", "maintenance.view",
    "automation.view",
  ],
  child: ["chores.view", "pets.view"],
  guest: ["chores.view", "pets.view", "shopping.view", "maintenance.view"],
};

/**
 * Mirrors `memberHasPermission` in firestore.rules for the module view
 * permissions: owners see everything, explicit overrides win, then the role's
 * defaults. Callers pass approved members only.
 * @param {object} member Membership record.
 * @param {ViewPermission} permission Permission to check.
 * @return {boolean} True when the member holds it.
 */
export const memberCanView = (
  member: {role?: unknown; permissions?: unknown},
  permission: ViewPermission,
): boolean => {
  if (typeof member.role !== "string") return false;
  if (member.role === "owner") return true;
  const overrides = member.permissions;
  if (
    overrides && typeof overrides === "object" &&
    Object.prototype.hasOwnProperty.call(overrides, permission)
  ) {
    return (overrides as Record<string, unknown>)[permission] === true;
  }
  return (ROLE_VIEW[member.role] ?? []).includes(permission);
};

type AudienceMember = {email?: unknown; role?: unknown; permissions?: unknown};

/**
 * Keeps the recipients who may see this category in the app. A recipient
 * whose membership record cannot be found is dropped.
 * @param {AudienceMember[]} members Approved membership records.
 * @param {string[]} emails Recipients chosen by targeting.
 * @param {unknown} category Notification category.
 * @return {string[]} Recipients allowed to receive the push.
 */
export const filterRecipientsByCategory = (
  members: AudienceMember[],
  emails: string[],
  category: unknown,
): string[] => {
  const permission = categoryViewPermission(category);
  if (permission === null) return emails;
  return emails.filter((email) => {
    const lower = email.toLowerCase();
    const member = members.find((m) =>
      typeof m.email === "string" && m.email.toLowerCase() === lower);
    return member ? memberCanView(member, permission) : false;
  });
};

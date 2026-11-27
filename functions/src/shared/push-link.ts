// The one push-link check, shared by the Cloud Function (safeDeepLink in
// push-policy.ts, for fcmOptions.link) and the service worker, which embeds
// this function's source (src/app/api/sw/route.ts). Keep it self-contained:
// no imports, nothing from outside its own body, and no named inner
// functions (build tools may wrap those in helpers the worker lacks).
// tests/unit/notifications-push-link.test.ts runs every layer, including the
// embedded copy, against one hostile-input table.

/**
 * A link opens only as an in-app path on this origin; anything else becomes
 * "/". It must start with exactly one "/" (no "//host", no "/\host"), hold no
 * control characters (URL parsing drops tabs and newlines, so "/<tab>/evil.com"
 * would open as "//evil.com"), no backslashes and no "." or ".." segments, raw
 * or percent-encoded, and must still resolve to the same origin.
 * @param {unknown} link Candidate link.
 * @return {string} A safe in-app path, or "/".
 */
export const safePushLink = (link: unknown): string => {
  if (typeof link !== "string") return "/";
  const trimmed = link.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return "/";
  if (!/^\/(?![/\\])/.test(trimmed)) return "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(trimmed.split(/[?#]/)[0]);
  } catch (error) {
    return "/";
  }
  // No control characters (U+0000-U+001F, U+007F) or backslashes, raw or
  // percent-encoded. A plain loop keeps the embedded source ASCII-only.
  const checked = trimmed + decodedPath;
  for (let index = 0; index < checked.length; index += 1) {
    const code = checked.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return "/";
  }
  const segments = decodedPath.split("/");
  if (segments.some((part) => part === ".." || part === ".")) return "/";
  if (decodedPath.startsWith("//")) return "/";
  try {
    const base = "https://homehub.invalid";
    if (new URL(trimmed, base).origin !== base) return "/";
  } catch (error) {
    return "/";
  }
  return trimmed;
};

/**
 * The link a push opens, with the notification's ID added as `?n=<id>` (or
 * `&n=<id>`, before any `#`), so the page that opens can mark it read
 * (NO-9). Only plain IDs are added; anything else leaves the link unchanged.
 * Self-contained like safePushLink (the worker embeds its source); run the
 * result through safePushLink again.
 * @param {string} link A link already checked by safePushLink.
 * @param {unknown} id Notification ID (the push tag).
 * @return {string} The link with the ID.
 */
export const pushOpenLink = (link: string, id: unknown): string => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    return link;
  }
  const hashAt = link.indexOf("#");
  const path = hashAt === -1 ? link : link.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : link.slice(hashAt);
  return path + (path.indexOf("?") === -1 ? "?" : "&") + "n=" + id + hash;
};

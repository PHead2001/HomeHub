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

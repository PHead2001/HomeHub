/**
 * Keeps email addresses out of anything sent to the model. Pure, so the client
 * (quick-add AI request) and the server (overview facts) share it and it is unit
 * tested. Display names fall back to emails for members without one, and free
 * text (notification titles, item names) can contain them.
 */
/** True when `text` contains something that looks like an email address. */
export function containsEmail(text: string): boolean {
  return /[^\s@]+@[^\s@]+/.test(text);
}

/** `text` with every email-like part replaced by `replacement`. */
export function redactEmails(text: string, replacement = 'a member'): string {
  return text.replace(/[^\s@]+@[^\s@]+/g, replacement);
}

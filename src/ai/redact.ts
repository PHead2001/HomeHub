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

/** Phone numbers: separated groups ("555-123-4567", "(555) 123 4567", "+1 555 123 4567") or 10-15 digits in a row; odometer readings (up to 7 digits) never match. */
const PHONE = /(?<![\w])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w])|(?<![\w.,])\+?\d{10,15}(?![\w.,])/g;
/** Street addresses: a house number, one to three words and a street type ("12 Oak Street", "4 Elm Ln"). */
const ADDRESS = /\b\d{1,6}\s+(?:[\p{L}'-]+\s+){1,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|boulevard|blvd|way|place|pl|circle|cir|terrace|ter|parkway|pkwy|highway|hwy)\b\.?/giu;

/**
 * `text` without emails, phone numbers or street addresses (QA-7), for free text
 * sent to the model (the quick-add AI reader).
 */
export function redactPersonal(text: string): string {
  return redactEmails(text).replace(PHONE, 'a phone number').replace(ADDRESS, 'an address');
}

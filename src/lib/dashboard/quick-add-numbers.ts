/**
 * Numbers in a quick-add sentence, shared by the deterministic parser
 * (`quick-add.ts`) and the AI reader's server-side check
 * (`src/ai/tasks/parse-command.ts`), so both read "48k", "120k miles" and
 * "48,200 mi" the same way and an AI answer is kept only when the sentence says it
 * (QA-3, QA-7). Pure: no Firebase, no React.
 */
import { parsePortion } from '../pets/schedule-parser';

/** The highest odometer reading quick add accepts. */
export const MAX_MILEAGE = 1_999_999;

const toNumber = (digits: string, thousands: boolean) => {
  const value = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const whole = Math.round(thousands ? value * 1000 : value);
  return whole > 0 && whole <= MAX_MILEAGE ? whole : null;
};

export type MileageMatch = { value: number; text: string; index: number };

/**
 * An odometer reading in `text`: "48,200 miles", "48200 mi", "120k miles",
 * "48.2k mi", "at 48,200" or "at 48k", and, when `bareK` is set (a sentence that
 * already names a service), a bare "48k". "120k" is 120,000, never 120. Plain
 * numbers need at least three digits with "miles" and four after "at", so
 * "2 filters" or "at 5" is never a reading.
 */
export function readMileage(text: string, options: { bareK?: boolean } = {}): MileageMatch | null {
  const patterns: RegExp[] = [
    /(?<![\d.,])(\d{1,3}(?:\.\d{1,3})?)\s*k\s*(?:miles|mi)\b/i,
    /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{3,7})\s*(?:miles|mi)\b/i,
    /\bat\s+(\d{1,3}(?:\.\d{1,3})?)\s*k\b/i,
    /\bat\s+(\d{1,3}(?:,\d{3})+|\d{4,7})(?![\d.,])/i,
  ];
  if (options.bareK) patterns.push(/(?<![\d.,\w])(\d{1,3}(?:\.\d{1,3})?)\s*k\b/i);
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const thousands = /k/i.test(match[0].slice(match[0].indexOf(match[1]) + match[1].length));
    const value = toNumber(match[1], thousands);
    if (value !== null) return { value, text: match[0], index: match.index };
  }
  return null;
}

/**
 * True when `value` is a number the sentence states: as digits (thousands
 * separators ignored) or as a "k" reading ("48k" is 48,000). An AI answer's
 * mileage is kept only then.
 */
export function mileageInText(value: number, text: string): boolean {
  if (!Number.isFinite(value)) return false;
  const digits = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  if (new RegExp(`(?<![\\d.])${Math.round(value)}(?![\\d.])(?!\\s*k\\b)`).test(digits)) return true;
  for (const match of digits.matchAll(/(?<![\d.,])(\d{1,3}(?:\.\d{1,3})?)\s*k\b/gi)) {
    if (toNumber(match[1], true) === value) return true;
  }
  return false;
}

/**
 * True when a feeding amount is what the sentence says: the Pets portion parser
 * reads the same amount from it ("1/2 cup", "one can", ".5 cups"), or the number is
 * written in it. A made-up portion from the AI reader is dropped (QA-7).
 */
export function portionInText(amount: number, text: string): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const portion = parsePortion(text);
  if (portion && Math.abs(portion.amount - amount) < 1e-6) return true;
  const escaped = String(amount).replace('.', '\\.');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`).test(text);
}

/**
 * One barcode form for the library, the scanner and lookup (BL-12). Pure; unit
 * tested in tests/unit/barcode-gtin.test.ts.
 *
 * `normalizeGtin` keeps digits only (spaces and hyphens dropped; anything else is
 * refused) and, for a retail code whose check digit is right, gives one ID:
 * - UPC-E (8 digits, number system 0 or 1) is expanded to its UPC-A;
 * - EAN-8, UPC-A (12) and EAN-13 are padded with leading zeros to 13 digits, so
 *   the UPC-A "012345678905" and the EAN-13 "0012345678905" are one product;
 * - a GTIN-14 with a leading 0 drops it (13 digits).
 * A code whose check digit does not match (an in-store code, a typo, the e2e
 * fixtures) is kept as its digits, unchanged, and reported as `checked: false`
 * so the Add form can warn without refusing it.
 */

export type GtinResult =
  | { ok: true; id: string; checked: boolean }
  | { ok: false; reason: 'empty' | 'not-digits' | 'length' };

export const MIN_BARCODE_DIGITS = 6;
export const MAX_BARCODE_DIGITS = 32;

/** Whether the last digit is the GS1 check digit of the others (any GTIN length). */
export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** A UPC-E code (8 digits with number system and check digit) as its 12-digit UPC-A, or null. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const [x1, x2, x3, x4, x5, x6] = code.slice(1, 7);
  const check = code[7];
  let body: string;
  if (x6 === '0' || x6 === '1' || x6 === '2') body = `${x1}${x2}${x6}0000${x3}${x4}${x5}`;
  else if (x6 === '3') body = `${x1}${x2}${x3}00000${x4}${x5}`;
  else if (x6 === '4') body = `${x1}${x2}${x3}${x4}00000${x5}`;
  else body = `${x1}${x2}${x3}${x4}${x5}0000${x6}`;
  const upcA = `${ns}${body}${check}`;
  return gtinCheckDigitValid(upcA) ? upcA : null;
}

/**
 * The one ID of a barcode. `format` is the decoder's format name when known
 * (`UPC_E` expands even when the 8 digits would also pass as an EAN-8).
 */
export function normalizeGtin(raw: unknown, format?: string | null): GtinResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const compact = raw.replace(/[\s-]+/g, '');
  if (!compact) return { ok: false, reason: 'empty' };
  if (!/^\d+$/.test(compact)) return { ok: false, reason: 'not-digits' };
  if (compact.length < MIN_BARCODE_DIGITS || compact.length > MAX_BARCODE_DIGITS) return { ok: false, reason: 'length' };
  if (compact.length === 8) {
    const upcA = expandUpcE(compact);
    const ean8 = gtinCheckDigitValid(compact);
    if (upcA && (format === 'UPC_E' || !ean8)) return { ok: true, id: upcA.padStart(13, '0'), checked: true };
    if (ean8) return { ok: true, id: compact.padStart(13, '0'), checked: true };
    return { ok: true, id: compact, checked: false };
  }
  if ((compact.length === 12 || compact.length === 13) && gtinCheckDigitValid(compact)) {
    return { ok: true, id: compact.padStart(13, '0'), checked: true };
  }
  if (compact.length === 14 && gtinCheckDigitValid(compact)) {
    return { ok: true, id: compact.startsWith('0') ? compact.slice(1) : compact, checked: true };
  }
  return { ok: true, id: compact, checked: false };
}

/** Why a typed code cannot be saved as a new product, or null (the Add form, BL-12). */
export function addBarcodeProblem(raw: string): string | null {
  const result = normalizeGtin(raw);
  if (result.ok) return null;
  if (result.reason === 'empty') return 'Barcode is required.';
  if (result.reason === 'not-digits') return 'A barcode has digits only.';
  return `Enter ${MIN_BARCODE_DIGITS} to ${MAX_BARCODE_DIGITS} digits.`;
}

/** The ID for a code, or its trimmed text when it is not a barcode (never throws). */
export const barcodeId = (raw: string, format?: string | null): string => {
  const result = normalizeGtin(raw, format);
  return result.ok ? result.id : raw.trim();
};

/** Whether two stored or scanned codes are the same product (both normalised). */
export function sameBarcode(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = normalizeGtin(a);
  const right = normalizeGtin(b);
  if (!left.ok || !right.ok) return false;
  return left.id === right.id;
}

/**
 * The document IDs a lookup tries, in order: the normalised ID, then the code
 * as given when it differs (a product saved before normalisation and not yet
 * migrated by scripts/ops/normalize-barcode-library.mjs).
 */
export function lookupIds(raw: string): string[] {
  const digits = raw.replace(/[\s-]+/g, '');
  const result = normalizeGtin(raw);
  if (!result.ok) return digits ? [digits] : [];
  return result.id === digits ? [digits] : [result.id, digits];
}

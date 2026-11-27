// Barcode Library document IDs (BL-12): the plain-JavaScript twin of
// src/lib/barcode/gtin.ts `normalizeGtin`, used by
// scripts/ops/normalize-barcode-library.mjs. tests/unit/barcode-gtin.test.ts
// checks both give the same IDs.

const checkDigitValid = (digits) => {
  if (!/^\d{2,}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
};

const expandUpcE = (code) => {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const [x1, x2, x3, x4, x5, x6] = code.slice(1, 7);
  let body;
  if (x6 === '0' || x6 === '1' || x6 === '2') body = `${x1}${x2}${x6}0000${x3}${x4}${x5}`;
  else if (x6 === '3') body = `${x1}${x2}${x3}00000${x4}${x5}`;
  else if (x6 === '4') body = `${x1}${x2}${x3}${x4}00000${x5}`;
  else body = `${x1}${x2}${x3}${x4}${x5}0000${x6}`;
  const upcA = `${ns}${body}${code[7]}`;
  return checkDigitValid(upcA) ? upcA : null;
};

/** The normalised ID of a stored barcode document ID, or null when it is not a barcode (left alone). */
export function normalizedBarcodeId(raw) {
  if (typeof raw !== 'string') return null;
  const compact = raw.replace(/[\s-]+/g, '');
  if (!/^\d{6,32}$/.test(compact)) return null;
  if (compact.length === 8) {
    // UPC-E first, as the app (one ID whatever the entry path).
    const upcA = expandUpcE(compact);
    if (upcA) return upcA.padStart(13, '0');
    return checkDigitValid(compact) ? compact.padStart(13, '0') : compact;
  }
  if ((compact.length === 12 || compact.length === 13) && checkDigitValid(compact)) return compact.padStart(13, '0');
  if (compact.length === 14 && checkDigitValid(compact)) return compact.startsWith('0') ? compact.slice(1) : compact;
  return compact;
}

/**
 * What the migration does with one product document:
 * - `current`: its ID is already the normalised one (or it is not a barcode);
 * - `move`: re-create it under the normalised ID and delete the old document;
 * - `collision`: the normalised ID is already taken (the same product saved
 *   twice, as UPC-A and EAN-13): both are left alone and counted for a person to
 *   merge, since either could hold the household's chosen name and photo.
 */
export function barcodeMoveDecision(id, existingIds) {
  const to = normalizedBarcodeId(id);
  if (!to || to === id) return { kind: 'current' };
  if (existingIds.has(to)) return { kind: 'collision', to };
  return { kind: 'move', to };
}

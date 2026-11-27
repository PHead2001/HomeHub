// The document IDs a Barcode Library product may live under (BL-12): the
// normalised 13-digit ID the app writes now, then the code as stored before
// normalisation. The same rule as src/lib/barcode/gtin.ts `lookupIds` (kept
// free of app imports for the functions build; a unit test checks both agree).

/**
 * Whether the last digit is the GS1 check digit of the others.
 * @param {string} digits A string of digits.
 * @return {boolean} True when the check digit matches.
 */
const checkDigitValid = (digits: string): boolean => {
  if (!/^\d{2,}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
};

/**
 * A UPC-E code as its 12-digit UPC-A, or null.
 * @param {string} code Eight digits, number system 0 or 1.
 * @return {string | null} The UPC-A, or null.
 */
const expandUpcE = (code: string): string | null => {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const [x1, x2, x3, x4, x5, x6] = code.slice(1, 7);
  let body: string;
  if (x6 === "0" || x6 === "1" || x6 === "2") {
    body = `${x1}${x2}${x6}0000${x3}${x4}${x5}`;
  } else if (x6 === "3") {
    body = `${x1}${x2}${x3}00000${x4}${x5}`;
  } else if (x6 === "4") {
    body = `${x1}${x2}${x3}${x4}00000${x5}`;
  } else {
    body = `${x1}${x2}${x3}${x4}${x5}0000${x6}`;
  }
  const upcA = `${code[0]}${body}${code[7]}`;
  return checkDigitValid(upcA) ? upcA : null;
};

/**
 * The normalised ID of a code, or the code itself when it is not a retail
 * barcode with a valid check digit.
 * @param {string} code The stored or scanned code.
 * @return {string} The ID the app saves it under.
 */
export const normalizedBarcodeId = (code: string): string => {
  const digits = code.replace(/[\s-]+/g, "");
  if (!/^\d{6,32}$/.test(digits)) return code;
  if (digits.length === 8) {
    // UPC-E first, as the app (one ID whatever the entry path).
    const upcA = expandUpcE(digits);
    if (upcA) return upcA.padStart(13, "0");
    return checkDigitValid(digits) ? digits.padStart(13, "0") : digits;
  }
  const retail = digits.length === 12 || digits.length === 13;
  if (retail && checkDigitValid(digits)) return digits.padStart(13, "0");
  if (digits.length === 14 && checkDigitValid(digits)) {
    return digits.startsWith("0") ? digits.slice(1) : digits;
  }
  return digits;
};

/**
 * The 8-digit UPC-E forms of a 12-digit UPC-A.
 * @param {string} a A 12-digit UPC-A.
 * @return {string[]} Its UPC-E forms (often none).
 */
const upcEForms = (a: string): string[] => {
  if (!/^[01]\d{11}$/.test(a)) return [];
  const forms: string[] = [];
  if ("012".includes(a[3]) && a.slice(4, 8) === "0000") {
    forms.push(a[0] + a[1] + a[2] + a[8] + a[9] + a[10] + a[3] + a[11]);
  }
  if (a.slice(4, 9) === "00000") {
    forms.push(a[0] + a.slice(1, 4) + a[9] + a[10] + "3" + a[11]);
  }
  if (a.slice(5, 10) === "00000") {
    forms.push(a[0] + a.slice(1, 5) + a[10] + "4" + a[11]);
  }
  if (a.slice(6, 10) === "0000" && "56789".includes(a[10])) {
    forms.push(a[0] + a.slice(1, 6) + a[10] + a[11]);
  }
  return [...new Set(forms.filter((form) => expandUpcE(form) === a))];
};

/**
 * The IDs to try, in order: the normalised one, the code as given, then the
 * product's other retail forms (12-digit UPC-A, 8-digit EAN-8 and UPC-E).
 * @param {string} code The stored or scanned code.
 * @return {string[]} The distinct IDs.
 */
export const barcodeLibraryIds = (code: string): string[] => {
  const normalized = normalizedBarcodeId(code);
  const digits = code.replace(/[\s-]+/g, "");
  if (!/^\d{6,32}$/.test(digits)) return [code];
  const ids = [normalized, digits];
  if (normalized.length === 13 && checkDigitValid(normalized)) {
    if (normalized.startsWith("0")) {
      ids.push(normalized.slice(1), ...upcEForms(normalized.slice(1)));
    }
    if (normalized.startsWith("00000")) ids.push(normalized.slice(5));
  }
  return [...new Set(ids)];
};

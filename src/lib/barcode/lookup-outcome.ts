/**
 * Barcode lookup outcomes (BL-9). A product that the public database does not
 * know ("not found") is different from a database that could not answer
 * (outage, timeout, rate limit, unreadable reply: "unavailable"), and the screens
 * say which. Pure: shared by the server lookup and the clients, unit tested in
 * tests/unit/barcode-lookup.test.ts.
 */

export type UnavailableReason = 'timeout' | 'rate_limited' | 'error';

export type OpenFoodFactsOutcome<P> =
  | { kind: 'found'; product: P }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; reason: UnavailableReason };

const SUCCESS_STATUSES = new Set<unknown>(['success', 'success_with_warnings', 'success_with_errors', 1]);

/**
 * Classifies an Open Food Facts v3 HTTP reply. 404 (or a "failure" status with a
 * readable body) is "not found"; 429 is a rate limit; any other non-2xx status or
 * an unreadable body means the service could not answer.
 */
export function classifyOpenFoodFactsReply<P>(status: number, payload: unknown): OpenFoodFactsOutcome<P> {
  if (status === 404) return { kind: 'not-found' };
  if (status === 429) return { kind: 'unavailable', reason: 'rate_limited' };
  if (status < 200 || status >= 300) return { kind: 'unavailable', reason: 'error' };
  if (!payload || typeof payload !== 'object') return { kind: 'unavailable', reason: 'error' };
  const body = payload as { status?: unknown; product?: unknown };
  if (SUCCESS_STATUSES.has(body.status)) {
    return body.product && typeof body.product === 'object'
      ? { kind: 'found', product: body.product as P }
      : { kind: 'not-found' };
  }
  if (body.status === 'failure' || body.status === 0) return { kind: 'not-found' };
  return { kind: 'unavailable', reason: 'error' };
}

/** A request that threw: an abort is the five-second timeout, anything else an outage. */
export function classifyOpenFoodFactsError(error: unknown): { kind: 'unavailable'; reason: UnavailableReason } {
  const name = typeof error === 'object' && error && 'name' in error ? String((error as { name?: unknown }).name) : '';
  return { kind: 'unavailable', reason: name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'error' };
}

/** The part of a lookup result the screens decide on. */
export type LookupSummary = {
  source: 'household' | 'open_food_facts' | 'none' | 'unavailable';
  productName?: string | null;
  unavailableReason?: UnavailableReason;
};

export type LookupMiss =
  | { kind: 'not-found' }
  | { kind: 'unavailable'; reason: UnavailableReason };

/** Null when the lookup named a product; otherwise why there is no product. */
export function lookupMiss(result: LookupSummary): LookupMiss | null {
  if (result.source === 'unavailable') return { kind: 'unavailable', reason: result.unavailableReason ?? 'error' };
  if (result.productName && result.productName.trim()) return null;
  return { kind: 'not-found' };
}

/**
 * Error codes of the lookup action itself (our server or the connection to it)
 * that also mean "could not look it up right now", not "no such product".
 */
const UNAVAILABLE_ACTION_CODES: Record<string, UnavailableReason> = {
  timeout: 'timeout',
  rate_limited: 'rate_limited',
  busy: 'rate_limited',
  unavailable: 'error',
  invalid_response: 'error',
};

/**
 * Maps a thrown lookup error to an unavailable miss when it is a capacity or
 * connection problem (an AiClientError code above, a failed fetch, offline);
 * null for anything else (sign-in, permission), which keeps its own error copy.
 */
export function lookupErrorMiss(error: unknown, offline = false): LookupMiss | null {
  if (offline) return { kind: 'unavailable', reason: 'error' };
  if (typeof error !== 'object' || !error) return null;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code in UNAVAILABLE_ACTION_CODES) return { kind: 'unavailable', reason: UNAVAILABLE_ACTION_CODES[code] };
  const name = 'name' in error ? String((error as { name?: unknown }).name) : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message) : '';
  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) return { kind: 'unavailable', reason: 'error' };
  return null;
}

/**
 * Copy for a lookup without a product. "Not found" offers saving the code to the
 * household library (when the member may save products); "unavailable" says the lookup could not answer and that
 * trying again later may work, never that the product is unknown.
 */
export function lookupMissCopy(miss: LookupMiss, fallback: string, canSave = true): { title: string; description: string } {
  if (miss.kind === 'not-found') {
    return {
      title: 'Product not found',
      description: canSave
        ? `No product matches that barcode. Save it to your Barcode Library so the next scan knows it, or ${fallback}.`
        : `No product matches that barcode. You can ${fallback}.`,
    };
  }
  const why = miss.reason === 'timeout'
    ? 'The product lookup took too long to answer.'
    : miss.reason === 'rate_limited'
      ? 'The product lookup is busy right now.'
      : 'The product lookup is not answering right now.';
  return { title: 'Lookup unavailable', description: `${why} Try the scan again in a moment, or ${fallback}.` };
}

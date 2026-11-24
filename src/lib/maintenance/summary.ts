// Stored AI summaries of a log's notes (MA-11d), pure. The server writes `summary` with the hash of
// the notes it summarized; the page shows the stored summary only while the notes still hash the
// same, and offers to regenerate it otherwise.
import type { MaintenanceLog } from '../types';

/** Notes as summarized: line endings and surrounding space do not change the hash. */
export const normalizeNotes = (notes: string | null | undefined) => (notes ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * A short, stable hash of the notes (two FNV-1a style 32-bit lanes, hex, with the length), the
 * same in the browser and on the server. Not a security measure: it only tells whether the notes
 * changed since the summary was made.
 */
export const notesHash = (notes: string | null | undefined): string => {
  const text = normalizeNotes(notes);
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x5bd1e995) >>> 0;
  }
  return `v1-${text.length.toString(36)}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};

export type StoredSummaryState =
  | { state: 'current'; summary: string }
  | { state: 'stale'; summary: string }
  | { state: 'none' };

/**
 * The stored summary of a log: `current` while the notes hash to the stored hash, `stale` when the
 * notes changed since (shown as outdated, regenerate on request), `none` without one. A legacy
 * `summary` written without a hash counts as stale.
 */
export const storedSummaryOf = (log: Pick<MaintenanceLog, 'notes' | 'summary' | 'summaryNotesHash'>): StoredSummaryState => {
  const summary = typeof log.summary === 'string' ? log.summary.trim() : '';
  if (!summary) return { state: 'none' };
  return log.summaryNotesHash && log.summaryNotesHash === notesHash(log.notes) ? { state: 'current', summary } : { state: 'stale', summary };
};

/** The model/version string stored with a summary (`{flow}@{version}/{model}`). */
export const SUMMARY_FLOW_VERSION = 'maintenance-summary@2';
export const summaryModelLabel = (model: string) => `${SUMMARY_FLOW_VERSION}/${model}`.slice(0, 200);

import 'server-only';

import type { Firestore } from 'firebase-admin/firestore';
import { HomeHubAiError } from '@/ai/errors';
import { isDocId } from '@functions/shared/push-media';
import { normalizeNotes, notesHash, summaryModelLabel } from '@/lib/maintenance/summary';

/**
 * Persisted AI summaries of a maintenance log (MA-11d). Server-written, the safer of the two
 * options: the action verifies `maintenance.view` and reads the notes from the log itself (never
 * text sent by the client), so nobody can store arbitrary text as a log's summary, and a member
 * who may only view maintenance can still keep a summary for everyone. Stored with the hash of
 * the notes it summarizes and the model/version; a request reuses the stored summary while the
 * notes still hash the same (no AI call, no quota), and regenerates only on request or when the
 * notes changed. If the notes change while the model runs, the new summary is returned but not
 * stored (it would describe notes that are gone).
 */
export type SummaryDeps = {
  generate: (notes: string) => Promise<{ summary: string; model: string }>;
  consumeQuota: () => Promise<void>;
  now: Date;
};

export type StoredSummaryResult = { summary: string; notesHash: string; stored: boolean; reused: boolean };

/** The longest notes the summary task accepts (its input schema). */
export const SUMMARY_NOTES_MAX = 8_000;

export async function summarizeAndStoreLog(
  db: Firestore,
  householdId: string,
  input: { logId: unknown; regenerate?: unknown },
  deps: SummaryDeps,
): Promise<StoredSummaryResult> {
  if (!isDocId(input.logId) || (input.regenerate !== undefined && typeof input.regenerate !== 'boolean')) {
    throw new HomeHubAiError('invalid_input');
  }
  const ref = db.collection('households').doc(householdId).collection('maintenance').doc(input.logId);
  const log = await ref.get();
  if (!log.exists) throw new HomeHubAiError('invalid_input');
  const notes = normalizeNotes(typeof log.get('notes') === 'string' ? log.get('notes') : '');
  if (!notes) throw new HomeHubAiError('invalid_input');
  const hash = notesHash(notes);
  const stored = log.get('summary');
  if (input.regenerate !== true && typeof stored === 'string' && stored.trim() && log.get('summaryNotesHash') === hash) {
    return { summary: stored, notesHash: hash, stored: true, reused: true };
  }
  await deps.consumeQuota();
  const { summary, model } = await deps.generate(notes.slice(0, SUMMARY_NOTES_MAX));
  const written = await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists || notesHash(typeof current.get('notes') === 'string' ? current.get('notes') : '') !== hash) return false;
    tx.update(ref, {
      summary,
      summaryNotesHash: hash,
      summaryModel: summaryModelLabel(model),
      summaryAt: deps.now.toISOString(),
    });
    return true;
  });
  return { summary, notesHash: hash, stored: written, reused: false };
}

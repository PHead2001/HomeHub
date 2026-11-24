'use client';

// Receipts picked in the log form are staged here until the log is saved (MA-16): the new log's
// id comes from the server, so the files are uploaded to it right after the save answers
// (`commitStagedReceipts`, called by useMaintenanceOps when a 'log' save or Log service
// completion succeeds). The form's own state is gone by then (the dialog closed), so the staged
// files live in this module, one log form at a time. The uploader is registered by
// useMaintenanceRecords (it knows the household and member). Opening the log form afresh clears
// anything left from an earlier opening.

export type StagedReceipt = { key: string; file: File };
export type ReceiptUploader = (logId: string, files: File[]) => Promise<void>;

let staged: StagedReceipt[] = [];
let uploader: ReceiptUploader | null = null;
const listeners = new Set<() => void>();

const emit = () => { for (const listener of listeners) listener(); };

export const receiptStaging = {
  /** The files staged by the open log form. */
  current(): readonly StagedReceipt[] {
    return staged;
  },
  set(next: StagedReceipt[]) {
    staged = next;
    emit();
  },
  clear() {
    if (staged.length === 0) return;
    staged = [];
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  setUploader(next: ReceiptUploader | null) {
    uploader = next;
  },
};

/**
 * Uploads the staged receipts to the log just saved (`logId`) and clears them. Nothing staged:
 * nothing happens. Runs after the save, so a failed upload never undoes the log (the uploader
 * reports it with Retry).
 */
export function commitStagedReceipts(logId: string) {
  if (staged.length === 0 || !uploader) return;
  const files = staged.map(entry => entry.file);
  staged = [];
  emit();
  void uploader(logId, files);
}

/** The log id a successful log save or completion answered with, if any. */
export const savedLogIdOf = (data: unknown): string | null => {
  if (!data || typeof data !== 'object') return null;
  const answer = data as { status?: unknown; id?: unknown; logId?: unknown };
  if (answer.status === 'saved' && typeof answer.id === 'string') return answer.id;
  if (answer.status === 'completed' && typeof answer.logId === 'string') return answer.logId;
  return null;
};

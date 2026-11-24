'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import {
  summarizeMaintenanceLogFlow,
  summarizeMaintenanceLogWithModel,
} from '@/ai/tasks/summarize-maintenance-log';
import type {
  SummarizeMaintenanceLogInput as TaskInput,
  SummarizeMaintenanceLogOutput as TaskOutput,
} from '@/ai/tasks/summarize-maintenance-log';
import { adminDb } from '@/lib/server/firebase-admin';
import { consumeAiQuota } from '@/lib/server/ai-quota';
import { summarizeAndStoreLog } from '@/lib/server/maintenance-summary';

export type SummarizeMaintenanceLogInput = TaskInput;
export type SummarizeMaintenanceLogOutput = TaskOutput;

/** Summarizes supplied text without storing it (kept for the e2e household probe). */
export async function summarizeMaintenanceLog(
  input: SummarizeMaintenanceLogInput,
  context: AiActionContext
): Promise<AiActionResult<SummarizeMaintenanceLogOutput>> {
  return executeAuthorizedAiAction({
    context,
    input,
    permission: 'maintenance.view',
    flowName: 'maintenance-summary',
    maxRequestsPerMinute: 12,
    task: () => summarizeMaintenanceLogFlow(input),
  });
}

export type StoredLogSummary = { summary: string; notesHash: string; stored: boolean; reused: boolean };

/**
 * Summarizes a log's own notes and stores the summary on the log (MA-11d; see
 * src/lib/server/maintenance-summary.ts). Needs `maintenance.view`. A stored summary whose notes
 * hash still matches is returned without an AI call or quota; `regenerate` asks for a new one.
 */
export async function summarizeStoredMaintenanceLog(
  input: { logId: string; regenerate?: boolean },
  context: AiActionContext,
): Promise<AiActionResult<StoredLogSummary>> {
  return executeAuthorizedAiAction({
    context,
    input,
    permission: 'maintenance.view',
    flowName: 'maintenance-summary',
    maxRequestsPerMinute: 12,
    // The quota is taken only when the model really runs (a stored summary is free).
    consumeQuota: false,
    task: user => summarizeAndStoreLog(adminDb, user.householdId, input ?? {}, {
      now: new Date(),
      consumeQuota: () => consumeAiQuota({ uid: user.uid, householdId: user.householdId, flowName: 'maintenance-summary' }),
      generate: async notes => {
        const { output, model } = await summarizeMaintenanceLogWithModel({ log: notes });
        return { summary: output.summary, model };
      },
    }),
  });
}

'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import {
  summarizeMaintenanceLogFlow,
} from '@/ai/tasks/summarize-maintenance-log';
import type {
  SummarizeMaintenanceLogInput as TaskInput,
  SummarizeMaintenanceLogOutput as TaskOutput,
} from '@/ai/tasks/summarize-maintenance-log';

export type SummarizeMaintenanceLogInput = TaskInput;
export type SummarizeMaintenanceLogOutput = TaskOutput;

export async function summarizeMaintenanceLog(
  input: SummarizeMaintenanceLogInput,
  context: AiActionContext
): Promise<AiActionResult<SummarizeMaintenanceLogOutput>> {
  return executeAuthorizedAiAction({
    context,
    permission: 'maintenance.view',
    flowName: 'maintenance-summary',
    maxRequestsPerMinute: 12,
    task: () => summarizeMaintenanceLogFlow(input),
  });
}

'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import { readReceiptFlow, RECEIPT_MAX_BASE64_CHARS, type ReadReceiptInput, type ReadReceiptOutput } from '@/ai/tasks/read-receipt';

export type { ReadReceiptInput, ReadReceiptOutput };

/**
 * "Read receipt" in the log form (MA-30). Needs `maintenance.createLogs` (the person filling in
 * a log), one daily AI request, and at most 6 a minute. Its payload budget is larger than other
 * AI actions' (one downsized photo or small PDF, under Next's 1 MB Server Action body); anything
 * bigger is `invalid_input` before authorization. Errors are the AI module's safe messages.
 */
export async function readMaintenanceReceipt(
  input: ReadReceiptInput,
  context: AiActionContext,
): Promise<AiActionResult<ReadReceiptOutput>> {
  return executeAuthorizedAiAction({
    context,
    input,
    permission: 'maintenance.createLogs',
    flowName: 'maintenance-receipt',
    maxRequestsPerMinute: 6,
    maxPayloadBytes: RECEIPT_MAX_BASE64_CHARS + 4 * 1024,
    task: async () => {
      const { cost, serviceProvider, partsUsed } = await readReceiptFlow(input);
      return { cost, serviceProvider, partsUsed };
    },
  });
}

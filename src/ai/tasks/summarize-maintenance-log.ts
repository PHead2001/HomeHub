import { z } from 'zod';
import { openAiModels } from '@/ai/model-config';
import { generateStructured, parseTaskInput, parseTaskOutput } from '@/ai/structured-generation';

export const SummarizeMaintenanceLogInputSchema = z.object({
  log: z.string().trim().min(1).max(8_000),
});
export type SummarizeMaintenanceLogInput = z.infer<typeof SummarizeMaintenanceLogInputSchema>;

export const SummarizeMaintenanceLogOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
});
export type SummarizeMaintenanceLogOutput = z.infer<typeof SummarizeMaintenanceLogOutputSchema>;

export async function summarizeMaintenanceLogFlow(
  candidateInput: SummarizeMaintenanceLogInput
): Promise<SummarizeMaintenanceLogOutput> {
  return (await summarizeMaintenanceLogWithModel(candidateInput)).output;
}

/** The summary and the model that wrote it (stored with a persisted summary, MA-11d). */
export async function summarizeMaintenanceLogWithModel(
  candidateInput: SummarizeMaintenanceLogInput
): Promise<{ output: SummarizeMaintenanceLogOutput; model: string }> {
  const input = parseTaskInput(SummarizeMaintenanceLogInputSchema, candidateInput);
  const result = await generateStructured({
    flowName: 'maintenance-summary',
    input,
    model: openAiModels.maintenance,
    outputSchema: SummarizeMaintenanceLogOutputSchema,
    timeoutMs: 15_000,
    maxOutputTokens: 500,
    taskInstruction: [
      'Summarize this home or vehicle maintenance log concisely.',
      'Preserve important work performed, unresolved issues, dates, mileage, costs, and next steps when present.',
      'Do not invent facts. Return only the requested structured output.',
    ].join('\n'),
  });
  return { output: parseTaskOutput(SummarizeMaintenanceLogOutputSchema, result.output), model: result.model };
}

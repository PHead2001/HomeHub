import { z } from 'genkit';
import { ai } from '@/ai/genkit';
import { openAiModels } from '@/ai/model-config';
import { generateStructured } from '@/ai/structured-generation';

export const SummarizeMaintenanceLogInputSchema = z.object({
  log: z.string().trim().min(1).max(8_000),
});
export type SummarizeMaintenanceLogInput = z.infer<typeof SummarizeMaintenanceLogInputSchema>;

export const SummarizeMaintenanceLogOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
});
export type SummarizeMaintenanceLogOutput = z.infer<typeof SummarizeMaintenanceLogOutputSchema>;

export const summarizeMaintenanceLogFlow = ai.defineFlow(
  {
    name: 'summarizeMaintenanceLogFlow',
    inputSchema: SummarizeMaintenanceLogInputSchema,
    outputSchema: SummarizeMaintenanceLogOutputSchema,
  },
  async input => {
    const result = await generateStructured({
      flowName: 'maintenance-summary',
      input,
      model: openAiModels.maintenance,
      outputSchema: SummarizeMaintenanceLogOutputSchema,
      timeoutMs: 15_000,
      maxOutputTokens: 500,
      prompt: [
        'Summarize this home or vehicle maintenance log concisely.',
        'Preserve important work performed, unresolved issues, dates, mileage, costs, and next steps when present.',
        'Do not invent facts. Return only the requested structured output.',
        `Maintenance log: ${JSON.stringify(input.log)}`,
      ].join('\n'),
    });
    return result.output;
  }
);

'use server';
/**
 * @fileOverview Summarizes maintenance logs for quick understanding of appliance and home repair status.
 *
 * - summarizeMaintenanceLog - A function that summarizes maintenance logs.
 * - SummarizeMaintenanceLogInput - The input type for the summarizeMaintenanceLog function.
 * - SummarizeMaintenanceLogOutput - The return type for the summarizeMaintenanceLog function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const SummarizeMaintenanceLogInputSchema = z.object({
  log: z.string().describe('The maintenance log to summarize.'),
});
export type SummarizeMaintenanceLogInput = z.infer<typeof SummarizeMaintenanceLogInputSchema>;

const SummarizeMaintenanceLogOutputSchema = z.object({
  summary: z.string().describe('A summary of the maintenance log.'),
});
export type SummarizeMaintenanceLogOutput = z.infer<typeof SummarizeMaintenanceLogOutputSchema>;

export async function summarizeMaintenanceLog(input: SummarizeMaintenanceLogInput): Promise<SummarizeMaintenanceLogOutput> {
  return summarizeMaintenanceLogFlow(input);
}

const prompt = ai.definePrompt({
  name: 'summarizeMaintenanceLogPrompt',
  input: {schema: SummarizeMaintenanceLogInputSchema},
  output: {schema: SummarizeMaintenanceLogOutputSchema},
  prompt: `You are an expert home maintenance assistant. Please summarize the following maintenance log in a concise and easy-to-understand manner.\n\nLog: {{{log}}}`,
});

const summarizeMaintenanceLogFlow = ai.defineFlow(
  {
    name: 'summarizeMaintenanceLogFlow',
    inputSchema: SummarizeMaintenanceLogInputSchema,
    outputSchema: SummarizeMaintenanceLogOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    return output!;
  }
);

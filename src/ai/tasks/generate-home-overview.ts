import { ai } from '@/ai/genkit';
import { openAiModels } from '@/ai/model-config';
import {
  HomeOverviewFactsSchema,
  HomeOverviewNarrativeSchema,
} from '@/ai/overview-schemas';
import type {
  HomeOverviewFacts,
  HomeOverviewNarrative,
  OverviewSection,
} from '@/ai/overview-types';
import { generateStructured } from '@/ai/structured-generation';

export const generateHomeOverviewNarrativeFlow = ai.defineFlow(
  {
    name: 'generateHomeOverviewNarrativeFlow',
    inputSchema: HomeOverviewFactsSchema,
    outputSchema: HomeOverviewNarrativeSchema,
  },
  async (facts: HomeOverviewFacts): Promise<HomeOverviewNarrative> => {
    const result = await generateStructured({
      flowName: 'overview',
      input: facts,
      model: openAiModels.overview,
      outputSchema: HomeOverviewNarrativeSchema,
      timeoutMs: 20_000,
      maxOutputTokens: 900,
      reasoningEffort: 'medium',
      taskInstruction: [
        'Write a concise household overview using only the supplied exact facts.',
        'Prioritize urgent and near-term work. Do not repeat private identifiers or invent numbers.',
        'Reference only sections present in the supplied facts. Return only the requested structured output.',
      ].join('\n'),
    });

    const authorizedSections = new Set(Object.keys(facts) as OverviewSection[]);
    return {
      ...result.output,
      priorities: result.output.priorities.filter(priority => authorizedSections.has(priority.sourceSection)),
      sectionSummaries: Object.fromEntries(Object.entries(result.output.sectionSummaries)
        .filter(([section]) => authorizedSections.has(section as OverviewSection))) as HomeOverviewNarrative['sectionSummaries'],
    };
  }
);

'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult, AiErrorCode } from '@/ai/errors';
import { aggregateHomeOverviewFacts } from '@/ai/overview-facts';
import type { HomeOverviewAiStatus, HomeOverviewResult } from '@/ai/overview-types';
import { generateHomeOverviewNarrativeFlow } from '@/ai/tasks/generate-home-overview';

const statusForError = (error: unknown): HomeOverviewAiStatus => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code as AiErrorCode : 'unavailable';
  if (code === 'configuration') return 'configuration_unavailable';
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'timeout') return 'timeout';
  if (code === 'invalid_response' || code === 'refused') return 'invalid_response';
  return 'provider_unavailable';
};

export async function generateHomeOverview(
  context: AiActionContext
): Promise<AiActionResult<HomeOverviewResult>> {
  return executeAuthorizedAiAction({
    context,
    permission: 'household.view',
    flowName: 'overview',
    maxRequestsPerMinute: 12,
    task: async user => {
      const { generatedAt, facts } = await aggregateHomeOverviewFacts(user);
      try {
        const narrative = await generateHomeOverviewNarrativeFlow(facts);
        return { generatedAt, facts, narrative, aiStatus: 'generated' };
      } catch (error) {
        return { generatedAt, facts, narrative: null, aiStatus: statusForError(error) };
      }
    },
  });
}

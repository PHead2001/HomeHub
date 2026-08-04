import { genkit } from 'genkit';
import { openAI } from '@genkit-ai/compat-oai/openai';
import { hasOpenAiApiKey, openAiModels } from '@/ai/model-config';

export const ai = genkit({
  plugins: hasOpenAiApiKey ? [openAI({ maxRetries: 0, timeout: 30_000 })] : [],
  ...(hasOpenAiApiKey ? { model: openAI.model(openAiModels.default) } : {}),
});

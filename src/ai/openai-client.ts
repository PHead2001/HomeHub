import OpenAI from 'openai';
import { hasOpenAiApiKey } from '@/ai/model-config';

/** Client-level request timeout; per-flow timeouts in `generateStructured` are shorter. */
export const OPENAI_CLIENT_TIMEOUT_MS = 30_000;

let client: OpenAI | undefined;

/**
 * Shared OpenAI client, created on first use and only when `OPENAI_API_KEY` exists.
 * The SDK reads the key from the server environment; application code never
 * passes, logs, or exposes its value. Automatic retries are disabled so one user
 * request is at most one paid provider request.
 */
export const getOpenAiClient = (): OpenAI | null => {
  if (!hasOpenAiApiKey) return null;
  client ??= new OpenAI({ maxRetries: 0, timeout: OPENAI_CLIENT_TIMEOUT_MS });
  return client;
};

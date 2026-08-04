export type AiErrorCode =
  | 'busy'
  | 'configuration'
  | 'forbidden'
  | 'invalid_input'
  | 'invalid_response'
  | 'rate_limited'
  | 'refused'
  | 'timeout'
  | 'unauthenticated'
  | 'unavailable';

const publicMessages: Record<AiErrorCode, string> = {
  busy: 'An AI request is already running. Please wait for it to finish.',
  configuration: 'AI is not configured right now. Please try again later.',
  forbidden: 'You do not have permission to use this AI feature.',
  invalid_input: 'The information provided for this AI request is invalid.',
  invalid_response: 'AI returned an invalid response. Please try again.',
  rate_limited: 'AI is receiving too many requests. Please wait a moment and retry.',
  refused: 'AI could not complete that request. Adjust the content and try again.',
  timeout: 'AI took too long to respond. Please try again.',
  unauthenticated: 'Your sign-in could not be verified. Please sign in again.',
  unavailable: 'AI is temporarily unavailable. Please try again later.',
};

export class HomeHubAiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, options?: { cause?: unknown }) {
    super(publicMessages[code], options);
    this.name = 'HomeHubAiError';
    this.code = code;
  }
}

export type AiActionError = {
  code: AiErrorCode;
  message: string;
};

export type AiActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AiActionError };

type ProviderErrorShape = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  status?: unknown;
};

export const normalizeAiError = (error: unknown): HomeHubAiError => {
  if (error instanceof HomeHubAiError) return error;

  const providerError = error && typeof error === 'object' ? error as ProviderErrorShape : {};
  const status = typeof providerError.status === 'number' ? providerError.status : undefined;
  const statusName = typeof providerError.status === 'string' ? providerError.status.toLowerCase() : '';
  const code = typeof providerError.code === 'string' ? providerError.code.toLowerCase() : '';
  const name = typeof providerError.name === 'string' ? providerError.name.toLowerCase() : '';
  const message = typeof providerError.message === 'string' ? providerError.message.toLowerCase() : '';

  if (code.includes('invalid_argument') || statusName.includes('invalid_argument')) {
    return new HomeHubAiError('invalid_input', { cause: error });
  }
  if (status === 401 || status === 403 || code.includes('api_key') || code.includes('model_not_found')) {
    return new HomeHubAiError('configuration', { cause: error });
  }
  if (status === 429 || code.includes('rate_limit')) {
    return new HomeHubAiError('rate_limited', { cause: error });
  }
  if (name.includes('timeout') || code.includes('timeout') || message.includes('timed out')) {
    return new HomeHubAiError('timeout', { cause: error });
  }
  if (message.includes('refus') || message.includes('content filter') || message.includes('blocked')) {
    return new HomeHubAiError('refused', { cause: error });
  }
  if (name.includes('zod') || message.includes('schema') || message.includes('parse')) {
    return new HomeHubAiError('invalid_response', { cause: error });
  }
  return new HomeHubAiError('unavailable', { cause: error });
};

export const toAiActionFailure = (error: unknown): AiActionResult<never> => {
  const normalized = normalizeAiError(error);
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
    },
  };
};

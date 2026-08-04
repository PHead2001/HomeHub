'use client';

import { auth } from '@/lib/firebase';
import type { AiActionContext } from '@/ai/action-auth';
import type { AiActionResult, AiErrorCode } from '@/ai/errors';

export class AiClientError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiClientError';
    this.code = code;
  }
}

export const getAiActionContext = async (householdId: string): Promise<AiActionContext> => {
  const user = auth.currentUser;
  if (!user) throw new AiClientError('unauthenticated', 'Your sign-in could not be verified. Please sign in again.');
  return {
    idToken: await user.getIdToken(),
    householdId,
  };
};

export const unwrapAiActionResult = <T>(result: AiActionResult<T>): T => {
  if (!result.ok) throw new AiClientError(result.error.code, result.error.message);
  return result.data;
};

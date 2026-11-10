'use client';

import { useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';

// Once Auth has answered on this page, later screens never wait again (a sign-in
// popup sets `loading` too, and must not swap the page for a skeleton).
let sessionKnownOnPage = false;

/**
 * SL-11: false only until Auth has said whether someone is signed in on this
 * page. Signed-in-only routes show their skeleton instead of the sign-in prompt
 * while it is false, and the header shows no Login button; a genuinely
 * signed-out visitor sees the prompt as soon as Auth answers.
 */
export function useSessionKnown(): boolean {
  const { loading, currentUser } = useAuth();
  const known = sessionKnownOnPage || !loading || currentUser !== null;
  useEffect(() => {
    if (known) sessionKnownOnPage = true;
  }, [known]);
  return known;
}

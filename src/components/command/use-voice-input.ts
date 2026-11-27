'use client';

/**
 * Voice add (H14) through the Web Speech API. `supported` is false where the API
 * is missing (the mic button is then hidden). Listening starts only from a tap: the
 * palette's mic calls `start` in its click handler, and the header's Speak button
 * or the tab bar's long-press start a session in their own tap that the palette
 * `adopt`s (`voice-session.ts`, QA-16). It stops after one phrase.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { attachVoiceSession, awaitVoiceSession, speechSupported, startVoiceSession, type VoiceAttachment } from './voice-session';

export function useVoiceInput() {
  // Mounted only on the client (inside the palette), so the check can run at init.
  const [supported] = useState(speechSupported);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachment = useRef<VoiceAttachment | null>(null);
  const cancelWait = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    cancelWait.current?.();
    attachment.current?.detach();
  }, []);

  const handlersFor = useCallback((onText: (text: string, final: boolean) => void) => ({
    // Listening is set as the session is taken over, before its replayed error or end.
    onAttach: () => {
      setError(null);
      setListening(true);
    },
    onText,
    onError: (message: string) => {
      setError(message);
      setListening(false);
    },
    onEnd: () => setListening(false),
  }), []);

  const take = useCallback((next: VoiceAttachment | null) => {
    if (!next) return false;
    attachment.current?.detach();
    attachment.current = next;
    return true;
  }, []);

  const stop = useCallback(() => {
    attachment.current?.stop();
  }, []);

  /** Starts listening; call it from a click handler. */
  const start = useCallback((onText: (text: string, final: boolean) => void) => {
    cancelWait.current?.();
    attachment.current?.detach();
    attachment.current = null;
    if (!startVoiceSession()) {
      setListening(false);
      setError('Voice input could not start. Try again or type instead.');
      return;
    }
    take(attachVoiceSession(handlersFor(onText)));
  }, [handlersFor, take]);

  /**
   * Takes over the session the opening tap started, or the one started within a few
   * seconds (the tab bar starts listening when the finger lifts).
   */
  const adopt = useCallback((onText: (text: string, final: boolean) => void) => {
    const handlers = handlersFor(onText);
    if (take(attachVoiceSession(handlers))) return;
    cancelWait.current?.();
    cancelWait.current = awaitVoiceSession(handlers, (next) => take(next));
  }, [handlersFor, take]);

  return { supported, listening, error, start, adopt, stop };
}

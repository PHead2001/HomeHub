'use client';

/**
 * Voice add (H14) through the Web Speech API. `supported` is false where the API
 * is missing (the mic button is then hidden). Listening starts only from an
 * explicit call (a tap or click) and stops after one phrase.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type RecognitionResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> };
type RecognitionErrorEvent = { error?: string };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionConstructor = new () => Recognition;

const getRecognition = (): RecognitionConstructor | null => {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor });
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
};

export function useVoiceInput() {
  // Mounted only on the client (inside the palette), so the check can run at init.
  const [supported] = useState(() => getRecognition() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);

  useEffect(() => () => recognition.current?.abort(), []);

  const stop = useCallback(() => {
    recognition.current?.stop();
  }, []);

  const start = useCallback((onText: (text: string, final: boolean) => void) => {
    const Constructor = getRecognition();
    if (!Constructor) return;
    recognition.current?.abort();
    const instance = new Constructor();
    instance.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
    instance.interimResults = true;
    instance.continuous = false;
    instance.maxAlternatives = 1;
    instance.onresult = (event) => {
      const results = Array.from(event.results);
      const text = results.map((result) => result[0]?.transcript ?? '').join(' ').trim();
      onText(text, results.every((result) => result.isFinal));
    };
    instance.onerror = (event) => {
      setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone access is blocked. Allow it in your browser settings to use voice add.'
        : event.error === 'no-speech' ? 'Did not catch that. Tap the mic and try again.' : 'Voice input stopped. Try again or type instead.');
      setListening(false);
    };
    instance.onend = () => setListening(false);
    recognition.current = instance;
    setError(null);
    try {
      instance.start();
      setListening(true);
    } catch {
      setListening(false);
      setError('Voice input could not start. Try again or type instead.');
    }
  }, []);

  return { supported, listening, error, start, stop };
}

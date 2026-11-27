'use client';

/**
 * One voice recognition session for quick add (H14, QA-16, QA-22), outside React so
 * it can start inside the tap that asked for it: iOS refuses speech recognition
 * started outside a user gesture, and the palette is a lazily loaded dialog that
 * mounts after the tap. The header's Speak button and the tab bar's long-press call
 * `startVoiceSession()` in their click handler; the palette then attaches to that
 * session (`attachVoiceSession`), which replays what was heard meanwhile.
 */
import { recognitionLanguage, voiceErrorMessage } from '@/lib/dashboard/voice';

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

export type VoiceHandlers = {
  /**
   * Called first when attaching, before anything heard meanwhile is replayed, so an
   * error or end that already happened is the state the listener is left in.
   */
  onAttach?: () => void;
  onText: (text: string, final: boolean) => void;
  onError: (message: string) => void;
  onEnd: () => void;
};

type Session = {
  recognition: Recognition;
  handlers: VoiceHandlers | null;
  heard: { text: string; final: boolean } | null;
  error: string | null;
  ended: boolean;
};

const getRecognition = (): RecognitionConstructor | null => {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor });
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
};

/** True where the browser has speech recognition. */
export const speechSupported = () => getRecognition() !== null;

let current: Session | null = null;
const waiting = new Set<(session: Session) => void>();

/**
 * Starts listening now. Call it from a click or tap handler. Returns false where
 * recognition is missing or refused to start. A session started earlier is aborted.
 */
export function startVoiceSession(): boolean {
  const Constructor = getRecognition();
  if (!Constructor) return false;
  current?.recognition.abort();
  const recognition = new Constructor();
  const session: Session = { recognition, handlers: null, heard: null, error: null, ended: false };
  // The parser reads English only, so recognition is asked for English (QA-16).
  recognition.lang = recognitionLanguage(typeof navigator !== 'undefined' ? navigator.language : undefined);
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const results = Array.from(event.results);
    const text = results.map((result) => result[0]?.transcript ?? '').join(' ').trim();
    session.heard = { text, final: results.every((result) => result.isFinal) };
    session.handlers?.onText(session.heard.text, session.heard.final);
  };
  recognition.onerror = (event) => {
    session.error = voiceErrorMessage(event.error);
    session.handlers?.onError(session.error);
  };
  recognition.onend = () => {
    session.ended = true;
    session.handlers?.onEnd();
  };
  try {
    recognition.start();
  } catch {
    return false;
  }
  current = session;
  for (const notify of [...waiting]) notify(session);
  return true;
}

export type VoiceAttachment = { stop: () => void; detach: () => void };

const bind = (session: Session, handlers: VoiceHandlers): VoiceAttachment => {
  session.handlers = handlers;
  handlers.onAttach?.();
  // Replay what happened before the palette attached (after onAttach, so a denied
  // microphone or a finished phrase is never overwritten by "listening").
  if (session.heard) handlers.onText(session.heard.text, session.heard.final);
  if (session.error) handlers.onError(session.error);
  if (session.ended) handlers.onEnd();
  return {
    stop: () => session.recognition.stop(),
    detach: () => {
      if (session.handlers === handlers) session.handlers = null;
      session.recognition.abort();
      if (current === session) current = null;
    },
  };
};

/** Attaches to the session started last, if nobody has it yet. */
export function attachVoiceSession(handlers: VoiceHandlers): VoiceAttachment | null {
  const session = current;
  if (!session || session.handlers) return null;
  return bind(session, handlers);
}

/**
 * Attaches to the next session started within `timeoutMs` (the tab bar's long-press
 * opens the palette first and starts listening when the finger lifts). Returns a
 * cancel function.
 */
export function awaitVoiceSession(handlers: VoiceHandlers, onAttach: (attachment: VoiceAttachment) => void, timeoutMs = 4000): () => void {
  const notify = (session: Session) => {
    cancel();
    if (!session.handlers) onAttach(bind(session, handlers));
  };
  const timer = setTimeout(() => cancel(), timeoutMs);
  function cancel() {
    clearTimeout(timer);
    waiting.delete(notify);
  }
  waiting.add(notify);
  return cancel;
}

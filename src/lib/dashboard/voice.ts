/**
 * Pure helpers for voice quick add (QA-16, QA-22). No browser APIs, so they are unit
 * tested (tests/unit/quick-add-section10.test.ts).
 */
import type { QuickAddIntent } from './quick-add';

/**
 * The recognition language: the browser's own when it is English (en-GB keeps
 * British spellings), else US English, because the quick-add parser reads English
 * only.
 */
export function recognitionLanguage(browserLanguage: string | undefined): string {
  return browserLanguage && /^en(?:-|$)/i.test(browserLanguage) ? browserLanguage : 'en-US';
}

/** What to say when recognition stops with an error. */
export function voiceErrorMessage(code: string | undefined): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone access is blocked. Allow it in your browser settings to use voice add.';
  if (code === 'no-speech') return 'Did not catch that. Tap Speak and try again.';
  if (code === 'aborted') return 'Voice input stopped.';
  return 'Voice input stopped. Try again or type instead.';
}

/** One line telling the member where their voice goes (QA-16). */
export const VOICE_DISCLOSURE = "Your browser's speech service turns what you say into text.";

/**
 * Whether a spoken sentence opens its preview at once (mic, speech, Confirm: QA-22).
 * Only an explicit intent does: a chore, a feeding, a maintenance log, or shopping
 * that said "add" or named a list. A bare-words grocery guess stays a suggestion.
 */
export function voiceAutoPreview(intent: QuickAddIntent | null): boolean {
  if (!intent) return false;
  return intent.kind !== 'shopping' || intent.explicit;
}

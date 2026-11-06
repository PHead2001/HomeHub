/**
 * Opt-in sound and haptic feedback (H21).
 *
 *   import { playFeedback } from '@/lib/feedback';
 *   playFeedback('complete');
 *
 * Call it right after the action succeeds (inside the user's click/tap handler
 * chain). It never throws and does nothing unless the member turned Sound and/or
 * Haptics on in Profile → Appearance. Sounds are synthesized with Web Audio (no
 * audio files); haptics use `navigator.vibrate` where it exists.
 */

export type FeedbackKind = 'complete' | 'add' | 'celebrate';

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['complete', 'add', 'celebrate'];

type Note = { freq: number; at: number; dur: number; type: OscillatorType; gain: number };

/** Each sound is a few short, quiet notes (≤ 400 ms total). */
export const FEEDBACK_SOUNDS: Record<FeedbackKind, Note[]> = {
  // Two rising notes: a satisfying "done".
  complete: [
    { freq: 660, at: 0, dur: 0.09, type: 'sine', gain: 1 },
    { freq: 990, at: 0.07, dur: 0.14, type: 'sine', gain: 0.9 },
  ],
  // One soft pop.
  add: [{ freq: 520, at: 0, dur: 0.08, type: 'triangle', gain: 1 }],
  // A quick major arpeggio.
  celebrate: [
    { freq: 523.25, at: 0, dur: 0.1, type: 'triangle', gain: 0.9 },
    { freq: 659.25, at: 0.07, dur: 0.1, type: 'triangle', gain: 0.9 },
    { freq: 783.99, at: 0.14, dur: 0.1, type: 'triangle', gain: 0.9 },
    { freq: 1046.5, at: 0.21, dur: 0.18, type: 'sine', gain: 1 },
  ],
};

/** Vibration patterns in ms (vibrate, pause, vibrate…). No pattern pulses faster than 3×/s for long. */
export const FEEDBACK_HAPTICS: Record<FeedbackKind, number[]> = {
  complete: [12, 40, 18],
  add: [10],
  celebrate: [15, 35, 15, 35, 40],
};

const MASTER_VOLUME = 0.07;

let settings = { sound: false, haptics: false };
let audioContext: AudioContext | null = null;

/** Called by the AppearanceProvider whenever the member changes the switches. */
export function configureFeedback(next: { sound: boolean; haptics: boolean }) {
  settings = { sound: next.sound, haptics: next.haptics };
}

export function getFeedbackSettings() {
  return { ...settings };
}

export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function canPlaySound(): boolean {
  return typeof window !== 'undefined' && typeof (window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) === 'function';
}

function getAudioContext(): AudioContext | null {
  if (!canPlaySound()) return null;
  if (!audioContext) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioContext = new Ctor();
  }
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => undefined);
  return audioContext;
}

function playSound(kind: FeedbackKind) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const start = ctx.currentTime + 0.01;
  for (const note of FEEDBACK_SOUNDS[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = note.type;
    osc.frequency.setValueAtTime(note.freq, start + note.at);
    const peak = MASTER_VOLUME * note.gain;
    gain.gain.setValueAtTime(0.0001, start + note.at);
    gain.gain.linearRampToValueAtTime(peak, start + note.at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + note.at);
    osc.stop(start + note.at + note.dur + 0.02);
  }
}

/**
 * Plays the sound and/or haptic for `kind` if the member enabled them.
 * `force` bypasses the switches (used only by the Profile "Test" buttons).
 */
export function playFeedback(kind: FeedbackKind, options: { force?: 'sound' | 'haptics' } = {}) {
  try {
    const sound = options.force ? options.force === 'sound' : settings.sound;
    const haptics = options.force ? options.force === 'haptics' : settings.haptics;
    if (sound) playSound(kind);
    if (haptics && canVibrate()) navigator.vibrate(FEEDBACK_HAPTICS[kind]);
  } catch {
    // Feedback is decoration; never let it break the action that triggered it.
  }
}

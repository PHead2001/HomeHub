/**
 * Pet easter egg (H29): long-press (or Shift+Enter on) a pet in the living house
 * to hear a short bark, meow or chirp. Synthesized with Web Audio (no audio files)
 * and played only when the member turned Sound on (Profile > Appearance), the
 * same switch `playFeedback` honors.
 */
import { canPlaySound, canVibrate, getFeedbackSettings } from '../feedback';

export type PetVoice = 'bark' | 'meow' | 'chirp';

/** One oscillator note with a pitch glide; times in seconds. */
export type VoiceNote = { at: number; dur: number; type: OscillatorType; from: number; to: number; gain: number };

export const PET_VOICES: Record<PetVoice, VoiceNote[]> = {
  // Two short "woofs": a quick downward glide on a buzzy wave.
  bark: [
    { at: 0, dur: 0.11, type: 'sawtooth', from: 520, to: 210, gain: 0.8 },
    { at: 0.16, dur: 0.1, type: 'sawtooth', from: 480, to: 200, gain: 0.7 },
  ],
  // "Mee-ow": up, then down.
  meow: [
    { at: 0, dur: 0.18, type: 'triangle', from: 520, to: 880, gain: 0.9 },
    { at: 0.17, dur: 0.24, type: 'triangle', from: 880, to: 430, gain: 0.8 },
  ],
  chirp: [
    { at: 0, dur: 0.07, type: 'sine', from: 1800, to: 2600, gain: 0.7 },
    { at: 0.1, dur: 0.07, type: 'sine', from: 1900, to: 2700, gain: 0.6 },
  ],
};

export function petVoice(type: string | undefined): PetVoice {
  if (type === 'Dog') return 'bark';
  if (type === 'Cat') return 'meow';
  return 'chirp';
}

/** The guard: sound must be switched on and Web Audio available. */
export function shouldPlayPetSound(settings: { sound: boolean }, audioAvailable: boolean): boolean {
  return settings.sound === true && audioAvailable;
}

/** Total length of a voice in seconds (each stays under half a second). */
export const voiceDuration = (voice: PetVoice) => Math.max(...PET_VOICES[voice].map((note) => note.at + note.dur));

const VOLUME = 0.06;
let context: AudioContext | null = null;

/** Plays the pet's voice if Sound is on. Returns whether a sound was started. Never throws. */
export function playPetSound(type: string | undefined): boolean {
  try {
    const settings = getFeedbackSettings();
    if (settings.haptics && canVibrate()) navigator.vibrate(12);
    if (!shouldPlayPetSound(settings, canPlaySound())) return false;
    if (!context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      context = new Ctor();
    }
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime + 0.01;
    for (const note of PET_VOICES[petVoice(type)]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type;
      osc.frequency.setValueAtTime(note.from, start + note.at);
      osc.frequency.exponentialRampToValueAtTime(note.to, start + note.at + note.dur);
      gain.gain.setValueAtTime(0.0001, start + note.at);
      gain.gain.linearRampToValueAtTime(VOLUME * note.gain, start + note.at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + note.at);
      osc.stop(start + note.at + note.dur + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}

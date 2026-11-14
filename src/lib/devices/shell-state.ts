// The tablet shell's state machine (docs/modules/devices/README.md, "Tablet shell";
// design 14.2-14.3, D-T3, D-T6, WT-5d, WT-8c/d, WT-14e/f). Pure: the React shell
// (src/components/devices/tablet-shell.tsx) feeds it events with the device clock and
// the shell busy flag (src/lib/shell/busy.ts) and carries out the effects it returns.
//
//   resting ──pick──▶ face(m) ──credited action──▶ face(m) [2 min slide]
//   face(m) ──Done | other pick | 2 min since last action & idle | idle return──▶ resting / face(m')
//   any ──PIN verified──▶ pin(m, session) ──gated use──▶ pin(m) [2 idle min slide]
//   pin(m) ──Done | 2 idle min & idle | pin_session_invalid | idle return──▶ resting (end session)
//   resting ⇄ ambient (ambient time without input; a tap wakes and never acts)
//   any ──removal observed──▶ revoked
//
// Every expiry waits while the shell is busy (a save in flight, an open Undo, unsaved
// input): a tick with `busy: true` changes nothing, and the next idle tick fires
// whatever became due meanwhile. Nothing here carries authority: the server re-checks
// the person, the level and the PIN session on every action.

import { FACE_MEMORY_MS, creditFace, faceExpired, rememberFace, type FaceMemory } from './face-memory';

/** A PIN unlock ends after 2 idle minutes (the server slides its session on every gated use). */
export const PIN_IDLE_MS = 2 * 60 * 1000;

export type PinUnlock = {
  memberUid: string;
  /** The session secret the server returned (memory only, never stored). */
  sessionId: string;
  unlockedAt: number;
  /** Device clock of the unlock or the last gated use that passed. */
  lastUsedAt: number;
};

export type ShellTimers = {
  /** Back to the start page after this long without input (`idle.homeAfterSec`). */
  homeAfterMs: number;
  /** Ambient screen after this long without input (`idle.ambientAfterSec`, never sooner than home). */
  ambientAfterMs: number;
};

export type ShellState = {
  face: FaceMemory | null;
  pin: PinUnlock | null;
  /** Device clock of the last touch, key or pointer input. */
  lastInputAt: number;
  /** The idle return already ran for the current idle period (reset by input). */
  idleReturned: boolean;
  ambient: boolean;
  revoked: boolean;
};

export type ShellEffect =
  /** Best effort `endPinSessionAction` (the server expiry stands regardless). */
  | { kind: 'end-pin-session'; sessionId: string }
  /** Close dialogs safely and go to the tablet's start page. */
  | { kind: 'go-start-page' };

export type ShellEvent =
  | { type: 'input'; now: number }
  | { type: 'pick'; memberUid: string; now: number }
  | { type: 'credit'; memberUid: string; now: number }
  | { type: 'pin-verified'; memberUid: string; sessionId: string; now: number }
  | { type: 'pin-used'; now: number }
  | { type: 'pin-invalid' }
  | { type: 'done' }
  | { type: 'tick'; now: number; busy: boolean }
  | { type: 'revoked' };

export type ShellTransition = { state: ShellState; effects: ShellEffect[] };

export const initialShellState = (now: number): ShellState => ({
  face: null, pin: null, lastInputAt: now, idleReturned: false, ambient: false, revoked: false,
});

/** Shell timers from the device record's idle settings (seconds). */
export const shellTimersFrom = (idle: { homeAfterSec: number; ambientAfterSec: number }): ShellTimers => ({
  homeAfterMs: idle.homeAfterSec * 1000,
  ambientAfterMs: Math.max(idle.ambientAfterSec, idle.homeAfterSec) * 1000,
});

const endPin = (pin: PinUnlock | null): ShellEffect[] => (pin ? [{ kind: 'end-pin-session', sessionId: pin.sessionId }] : []);

export const pinExpired = (pin: PinUnlock | null, now: number): boolean => Boolean(pin) && now - pin!.lastUsedAt >= PIN_IDLE_MS;

export function shellReducer(state: ShellState, event: ShellEvent, timers: ShellTimers): ShellTransition {
  if (state.revoked) return { state, effects: [] };
  switch (event.type) {
    case 'input':
      // A touch wakes the ambient screen and starts a new idle period; it never acts by itself.
      return { state: { ...state, lastInputAt: Math.max(state.lastInputAt, event.now), idleReturned: false, ambient: false }, effects: [] };
    case 'pick': {
      // Choosing someone else ends the previous person's PIN unlock.
      const keepPin = state.pin && state.pin.memberUid === event.memberUid ? state.pin : null;
      return {
        state: { ...state, face: rememberFace(event.memberUid, event.now), pin: keepPin },
        effects: keepPin ? [] : endPin(state.pin),
      };
    }
    case 'credit':
      return { state: { ...state, face: creditFace(state.face, event.memberUid, event.now) }, effects: [] };
    case 'pin-verified': {
      const replaced = state.pin && state.pin.sessionId !== event.sessionId ? endPin(state.pin) : [];
      return {
        state: {
          ...state,
          face: creditFace(state.face, event.memberUid, event.now),
          pin: { memberUid: event.memberUid, sessionId: event.sessionId, unlockedAt: event.now, lastUsedAt: event.now },
        },
        effects: replaced,
      };
    }
    case 'pin-used':
      return state.pin ? { state: { ...state, pin: { ...state.pin, lastUsedAt: Math.max(state.pin.lastUsedAt, event.now) } }, effects: [] } : { state, effects: [] };
    case 'pin-invalid':
      // The server said the session is gone (pin_session_invalid): nothing to end.
      return { state: { ...state, pin: null }, effects: [] };
    case 'done':
      return { state: { ...state, face: null, pin: null }, effects: endPin(state.pin) };
    case 'revoked':
      return { state: { ...state, face: null, pin: null, ambient: false, revoked: true }, effects: [] };
    case 'tick': {
      // While busy every expiry waits; the next idle tick fires whatever is due.
      if (event.busy) return { state, effects: [] };
      const now = event.now;
      let next = state;
      const effects: ShellEffect[] = [];
      if (pinExpired(next.pin, now)) {
        effects.push(...endPin(next.pin));
        next = { ...next, pin: null };
      }
      if (faceExpired(next.face, now)) next = { ...next, face: null };
      const idleFor = now - next.lastInputAt;
      if (!next.idleReturned && idleFor >= timers.homeAfterMs) {
        effects.push(...endPin(next.pin));
        effects.push({ kind: 'go-start-page' });
        next = { ...next, face: null, pin: null, idleReturned: true };
      }
      if (!next.ambient && idleFor >= timers.ambientAfterMs) next = { ...next, ambient: true };
      return { state: next, effects };
    }
    default:
      return { state, effects: [] };
  }
}

/**
 * The next device-clock time at which a tick changes something (PIN idle expiry, face
 * expiry, idle return, ambient), or null when nothing is pending. The shell sets one
 * timer to it; a busy shell ticks again when it becomes idle.
 */
export function nextShellDeadline(state: ShellState, timers: ShellTimers): number | null {
  if (state.revoked) return null;
  const candidates: number[] = [];
  if (state.pin) candidates.push(state.pin.lastUsedAt + PIN_IDLE_MS);
  if (state.face) candidates.push(state.face.lastActionAt + FACE_MEMORY_MS);
  if (!state.idleReturned) candidates.push(state.lastInputAt + timers.homeAfterMs);
  if (!state.ambient) candidates.push(state.lastInputAt + timers.ambientAfterMs);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** The person acting right now, if any: a PIN unlock wins over face memory. */
export const currentActor = (state: ShellState): { memberUid: string; level: 'face' | 'pin' } | null => {
  if (state.pin) return { memberUid: state.pin.memberUid, level: 'pin' };
  if (state.face) return { memberUid: state.face.memberUid, level: 'face' };
  return null;
};

export type SettingsLayer = 'admin' | 'confirm' | 'main' | 'hidden';

/**
 * Which Tablet settings dialog shows (design 14.6). While "Who's here?" or the PIN pad
 * runs (`prompting`), the settings and exit-confirm dialogs step aside entirely, so the
 * picker and the pad are the only dialog (focus trapped there; Escape cancels the prompt
 * and settings come back). Radix stacks dialogs by mount order, so a settings dialog that
 * (re)opened at the same moment as the picker would otherwise cover it. The admin
 * settings form stays mounted (its unsaved draft must survive); the PIN pad it asks for
 * at save time mounts after it and so sits on top.
 */
export const settingsLayer = (state: { admin: boolean; confirming: boolean; prompting: boolean }): SettingsLayer => {
  if (state.admin) return 'admin';
  if (state.prompting) return 'hidden';
  return state.confirming ? 'confirm' : 'main';
};

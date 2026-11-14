// Face memory on a registered wall tablet (docs/modules/devices/README.md, "Tablet
// shell"; design 6.3, D-T3, WT-8c/d). Pure client state: who was last chosen in
// "Who's here?" and when an action was last credited to them. It carries NO
// authority: every action sends `actorUid` and the server re-checks the person each
// time. Expiry only means the tablet asks "Who's here?" again.

/** The choice is remembered for 2 minutes, sliding from the last credited action (D-T3). */
export const FACE_MEMORY_MS = 2 * 60 * 1000;

export type FaceMemory = {
  memberUid: string;
  /** Device clock (ms) of the pick or of the last action credited to this person. */
  lastActionAt: number;
};

/** A person was chosen in "Who's here?". */
export const rememberFace = (memberUid: string, now: number): FaceMemory => ({ memberUid, lastActionAt: now });

/** An action was credited to the remembered person: the 2 minutes start again. */
export const creditFace = (face: FaceMemory | null, memberUid: string, now: number): FaceMemory =>
  face && face.memberUid === memberUid ? { memberUid, lastActionAt: Math.max(face.lastActionAt, now) } : rememberFace(memberUid, now);

export const faceExpiresAt = (face: FaceMemory): number => face.lastActionAt + FACE_MEMORY_MS;

export const faceExpired = (face: FaceMemory | null, now: number): boolean => Boolean(face) && now >= faceExpiresAt(face!);

/**
 * The remembered person to use for a new action right now. An expired memory is
 * forgotten only while the shell is idle: during a save, an open Undo or unsaved input
 * it is kept (the expiry is pending and fires when the shell becomes idle), so expiry
 * never interrupts anything (WT-8d).
 */
export const activeFace = (face: FaceMemory | null, now: number, busy: boolean): FaceMemory | null => {
  if (!face) return null;
  if (busy) return face;
  return faceExpired(face, now) ? null : face;
};

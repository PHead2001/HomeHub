// The tap guard on the tablet's prompts (docs/modules/devices/README.md, "Tablet shell").
// "Who's here?", the PIN pad and "Feed again?"/"Already given?" open on top of whatever was
// just tapped, under the same finger: the second tap of a double tap on Save would otherwise
// land on a face (crediting whoever was there) or a key. A pointer activation of a prompt's
// choice counts only when its press began at least `PROMPT_TAP_GUARD_MS` after the prompt
// opened (so a press that began before it opened never counts); the keyboard is never held.
// Pure, unit tested; the browser binding is `usePromptTapGuard`.

export const PROMPT_TAP_GUARD_MS = 400;

export type PromptTap = {
  /** When the prompt opened (performance.now()). */
  openedAt: number | null;
  /** When the latest pointer press seen since it opened began; null when none has. */
  pressStartedAt: number | null;
  /** A keyboard activation (a click with `detail === 0`). */
  keyboard: boolean;
};

/** Whether a click on one of a prompt's choices counts. */
export function promptTapAllowed({ openedAt, pressStartedAt, keyboard }: PromptTap): boolean {
  if (keyboard) return true;
  if (openedAt === null || pressStartedAt === null) return false;
  return pressStartedAt - openedAt >= PROMPT_TAP_GUARD_MS;
}

// Quick add on a registered wall tablet: local matching only (docs/modules/devices/README.md,
// "Tablet shell"; design 8.2, JC-28). The AI reader (quick-add parsing, Speak) is not on
// tablets, so the tablet's Add box matches what was typed against names it already
// shows: pet names give feed (or dose) intents, chore titles give "mark done" intents.
// Each intent names the device capability the server would check; nothing is written
// here. Pure.

import type { DeviceCapability } from './action-policy';
import type { DeviceSections } from './types';

export type LocalPet = { id: string; name: string };
export type LocalChore = { id: string; title: string; roomName?: string | null };

export type LocalIntent =
  | { kind: 'feed'; capability: 'pets.feed'; petId: string; label: string }
  | { kind: 'dose'; capability: 'pets.dose.give'; petId: string; label: string }
  | { kind: 'complete'; capability: 'chores.complete'; choreId: string; label: string };

/** At most this many suggestions are shown. */
export const LOCAL_INTENT_LIMIT = 6;

const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const FEED_WORDS = /\b(feed|fed|feeding|food|meal|breakfast|dinner|supper)\b/;
const DOSE_WORDS = /\b(dose|doses|meds|medicine|medication|pill|pills|tablet|drops)\b/;
const DONE_WORDS = /\b(done|did|finished|complete|completed|tick)\b/;

/** Whole-word containment of a name in the typed text, or a prefix of a single typed word (as the person types). */
const mentions = (text: string, name: string): boolean => {
  const n = normalize(name);
  if (!n) return false;
  if (` ${text} `.includes(` ${n} `)) return true;
  const words = text.split(' ');
  const last = words[words.length - 1] ?? '';
  return last.length >= 2 && n.startsWith(last) && words.length <= 2;
};

/**
 * Intents for the typed text. Pets only when the Pets section is on, chores only when
 * Chores is on (switched-off sections vanish from quick add, WT-11b). Empty text gives
 * nothing.
 */
export function matchLocalIntents(
  input: string,
  context: { pets: readonly LocalPet[]; chores: readonly LocalChore[]; sections: DeviceSections },
): LocalIntent[] {
  const text = normalize(input);
  if (!text) return [];
  const out: LocalIntent[] = [];
  if (context.sections.pets) {
    const wantsDose = DOSE_WORDS.test(text);
    const wantsFeed = FEED_WORDS.test(text) || !wantsDose;
    for (const pet of context.pets) {
      if (!mentions(text, pet.name)) continue;
      if (wantsFeed) out.push({ kind: 'feed', capability: 'pets.feed', petId: pet.id, label: `Feed ${pet.name}` });
      if (wantsDose) out.push({ kind: 'dose', capability: 'pets.dose.give', petId: pet.id, label: `Give ${pet.name} a dose` });
    }
  }
  if (context.sections.chores) {
    const stripped = text.replace(DONE_WORDS, ' ').replace(/\s+/g, ' ').trim();
    for (const chore of context.chores) {
      const title = normalize(chore.title);
      if (!title || !stripped) continue;
      if (title.includes(stripped) || mentions(stripped, chore.title)) {
        out.push({ kind: 'complete', capability: 'chores.complete', choreId: chore.id, label: `Mark "${chore.title}" done` });
      }
    }
  }
  return out.slice(0, LOCAL_INTENT_LIMIT);
}

/** The capability a local intent asks the server for. */
export const capabilityOf = (intent: LocalIntent): DeviceCapability => intent.capability;

import type { DashboardFacts } from '@/lib/dashboard/facts';
import type { DeviceSections } from './types';

/**
 * SL-23: the richer ambient screen of a registered wall tablet (one spec, 16.2: clock,
 * weather, the house with pets moving slowly, and the next-up line, drifting against
 * burn-in). What it may say follows the ambient rules (WT-5a, HP-16): household facts
 * only, never a member's name; sections switched off on the tablet say nothing; an
 * unknown state is never drawn as a known one.
 *
 * Pure; unit tested in tests/unit/shell-section-11.test.ts.
 */

export type AmbientPetKind = 'dog' | 'cat' | 'other';
/** `bowl`: a meal is due now; `wander`: fed or not due; `rest`: its feeding history is unknown. */
export type AmbientPetSpot = 'bowl' | 'wander' | 'rest';
export type AmbientPet = { id: string; kind: AmbientPetKind; spot: AmbientPetSpot };

/** At most this many pets are drawn in the house. */
export const AMBIENT_PET_MAX = 4;

const kindOf = (type: string): AmbientPetKind => {
  const value = type.trim().toLowerCase();
  if (value === 'dog') return 'dog';
  if (value === 'cat') return 'cat';
  return 'other';
};

/** The pets drawn in the house, without names. Empty when Pets is off or not known. */
export function ambientPets(facts: DashboardFacts | null | undefined, sections: DeviceSections): AmbientPet[] {
  if (!sections.pets || !facts?.pets) return [];
  return facts.pets.pets.slice(0, AMBIENT_PET_MAX).map((pet) => ({
    id: pet.id,
    kind: kindOf(pet.type),
    spot: pet.fed === null ? 'rest' : pet.needsMeal ? 'bowl' : 'wander',
  }));
}

/** Where pets can stand inside the house (percent of its box), left to right. */
export const WANDER_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [30, 72], [48, 74], [64, 70], [38, 56], [58, 55], [70, 76],
];
/** By the bowl (bottom left), one place per pet. */
const BOWL_SPOTS: ReadonlyArray<readonly [number, number]> = [[22, 80], [30, 81], [24, 70], [34, 72]];
/** A pet whose feeding is unknown rests in a corner and never moves. */
const REST_SPOTS: ReadonlyArray<readonly [number, number]> = [[74, 80], [66, 81], [74, 70], [62, 72]];

/**
 * A pet's position at drift step `step` (one step a minute): wandering pets move to
 * another spot each step, pets at the bowl or resting stay put. Two wandering pets
 * never share a spot.
 */
export function ambientPetPosition(pet: AmbientPet, index: number, step: number): readonly [number, number] {
  if (pet.spot === 'bowl') return BOWL_SPOTS[index % BOWL_SPOTS.length];
  if (pet.spot === 'rest') return REST_SPOTS[index % REST_SPOTS.length];
  // Pets are at most four and the spots six, so two pets never share one.
  return WANDER_SPOTS[(index + step) % WANDER_SPOTS.length];
}

/**
 * "Next up: Water the plants · Today": the household's first open chore, with no
 * assignee. Null when Chores is off on this tablet, not known yet, or nothing is
 * open (the screen then says nothing rather than claiming the house is done).
 */
export function ambientNextUp(facts: DashboardFacts | null | undefined, sections: DeviceSections): string | null {
  if (!sections.chores || !facts?.chores) return null;
  const next = facts.chores.nextUp[0];
  if (!next) return null;
  const task = next.task.trim();
  if (!task) return null;
  const due = next.dueLabel.trim();
  return due ? `Next up: ${task} · ${due}` : `Next up: ${task}`;
}

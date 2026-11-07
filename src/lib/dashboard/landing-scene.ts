/**
 * The landing page's sample house (H03): which pieces show at each scroll stage.
 * Pure, so the assembly order is unit tested. Fictional data only; the landing
 * page never reads Firestore.
 */
export type LandingModule = 'chores' | 'shopping' | 'pets' | 'maintenance';

export const SAMPLE_ROOMS = [
  { id: 'kitchen', name: 'Kitchen' },
  { id: 'living', name: 'Living Room' },
  { id: 'bedroom', name: 'Bedroom' },
  { id: 'garage', name: 'Garage' },
] as const;

/** Each feature step, in scroll order, and the room its tile flies into. */
export const LANDING_STEPS: ReadonlyArray<{ module: LandingModule; roomId: (typeof SAMPLE_ROOMS)[number]['id']; title: string; body: string }> = [
  { module: 'chores', roomId: 'living', title: 'Chores that finish themselves', body: 'Rooms glow when something is overdue and sparkle when the work is done. Recurring chores schedule themselves.' },
  { module: 'shopping', roomId: 'kitchen', title: 'Lists for the whole house', body: 'Shared shopping lists that work offline in the store, with a pantry that knows what expires soon.' },
  { module: 'pets', roomId: 'bedroom', title: 'Pets, fed on time', body: 'See at a glance who was fed and when, and log a meal in one tap.' },
  { module: 'maintenance', roomId: 'garage', title: 'Maintenance without the binder', body: 'Filters, warranties, tire rotations and registrations, reminded before they are due.' },
];

/** Stage 0 shows the foundation and walls; each step adds a layer; the last is the whole house. */
export const FINAL_STAGE = LANDING_STEPS.length;

export type LandingPiece = 'foundation' | 'rooms' | 'roof' | 'pets' | 'details';

/** The stage at which each piece of the house appears. */
export const PIECE_STAGE: Record<LandingPiece, number> = {
  foundation: 0,
  rooms: 1,
  roof: 2,
  pets: 3,
  details: 4,
};

export const pieceVisible = (piece: LandingPiece, stage: number) => stage >= PIECE_STAGE[piece];

/** A module tile is in its room once its step has been reached. */
export const moduleVisible = (module: LandingModule, stage: number) =>
  stage >= LANDING_STEPS.findIndex((step) => step.module === module) + 1;

/** Stage to show: everything under reduced motion, else the furthest step reached (never goes back). */
export function landingStage(reached: number, reduced: boolean): number {
  if (reduced) return FINAL_STAGE;
  return Math.max(0, Math.min(FINAL_STAGE, Math.floor(reached)));
}

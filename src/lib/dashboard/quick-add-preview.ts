/**
 * What the command palette's quick-add preview card says (H13), from the intent
 * alone, so the deterministic parser, the AI reader and the card are tested
 * together. Pure: no Firebase or React.
 */
import { DEFAULT_PORTION, formatPortion } from '../pets/care';
import type { PortionUnit } from '../pets/types';
import { describeRepeat, type MaintenanceTarget, type QuickAddIntent, type QuickAddMember, type QuickAddVehicle } from './quick-add';

/** Palette index collections a preview can depend on. */
export const INDEX_SECTIONS = ['members', 'lists', 'pets', 'rooms', 'vehicles', 'assets'] as const;
export type IndexSection = (typeof INDEX_SECTIONS)[number];

/** What each quick-add kind picks from (its preview's choices and its write). */
const NEEDS: Record<QuickAddIntent['kind'], readonly IndexSection[]> = {
  chore: ['members', 'rooms'],
  maintenance: ['vehicles', 'assets'],
  shopping: ['lists'],
  feeding: ['pets'],
};

const SECTION_WORDS: Record<IndexSection, string> = {
  members: 'members',
  lists: 'shopping lists',
  pets: 'pets',
  rooms: 'rooms',
  vehicles: 'vehicles',
  assets: 'home assets',
};

/** The failed sections this intent depends on (empty when it can trust what loaded). */
export function failedSectionsFor(intent: QuickAddIntent, failed: readonly IndexSection[]): IndexSection[] {
  return NEEDS[intent.kind].filter((section) => failed.includes(section));
}

/**
 * The vehicle or asset a maintenance preview starts with: the one the sentence
 * named, else the household's only vehicle for a mileage reading, else none.
 * Derived from the loaded records (not frozen when the card opened), so the only
 * vehicle is preselected even if the records arrived after the card.
 */
export function defaultMaintenanceTarget(intent: QuickAddIntent, vehicles: readonly QuickAddVehicle[]): MaintenanceTarget | null {
  if (intent.kind !== 'maintenance') return null;
  if (intent.target) return intent.target;
  // A name that fits several records is never resolved for the member.
  if (intent.targetQuery) return null;
  if (intent.mileage !== null && vehicles.length === 1) return { kind: 'vehicle', vehicle: vehicles[0] };
  return null;
}

/**
 * Why Confirm is unavailable on a quick-add preview, or null when it can save.
 * The vehicles, assets, members, rooms and lists the preview picks from come from
 * the palette's index; until it has loaded, a choice made now could be wrong (a
 * mileage saved as a general log because no vehicle was known yet), so every kind
 * waits for it. A mileage then needs a vehicle when the household has any.
 */
export function quickAddConfirmBlocker({
  intent,
  indexLoading,
  vehicleCount,
  chosenTarget,
  chosenAssignee = null,
  failedSections = [],
}: {
  intent: QuickAddIntent;
  indexLoading: boolean;
  vehicleCount: number;
  chosenTarget: MaintenanceTarget | null;
  /** The assignee picked in the preview (needed when the sentence's name was ambiguous). */
  chosenAssignee?: QuickAddMember | null;
  /**
   * Index sections whose read failed. A failure is never treated as "none": a
   * mileage would otherwise be saved as a general log because no vehicle loaded.
   */
  failedSections?: readonly IndexSection[];
}): string | null {
  if (indexLoading) return "Loading your household's members, rooms, lists and vehicles…";
  const missing = failedSectionsFor(intent, failedSections);
  if (missing.length > 0) {
    const words = missing.map((section) => SECTION_WORDS[section]);
    const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
    return `Couldn't load your household's ${list}, so this can't be saved yet. Try again, or close the palette and open it again.`;
  }
  if (intent.kind === 'maintenance' && intent.targetQuery && !intent.target && !chosenTarget) {
    return `More than one ${intent.mileage !== null ? 'vehicle' : 'vehicle or asset'} matches ${intent.targetQuery}. Choose which one.`;
  }
  if (intent.kind === 'chore' && intent.assigneeQuery && !intent.assignee && !chosenAssignee) {
    return `More than one member is called ${intent.assigneeQuery}. Choose who this chore is for.`;
  }
  if (intent.kind === 'maintenance' && intent.mileage !== null && vehicleCount > 0 && chosenTarget?.kind !== 'vehicle') {
    return 'Choose the vehicle this reading belongs to.';
  }
  return null;
}

export const maintenanceTargetName = (target: MaintenanceTarget | null | undefined) =>
  target ? (target.kind === 'vehicle' ? target.vehicle.name : target.asset.name) : null;

/** The amount to log: the one in the sentence, else the pet's usual portion, else the Pets default. */
export function feedingPortion(intent: Extract<QuickAddIntent, { kind: 'feeding' }>): { amount: number; unit: PortionUnit } {
  if (intent.amount !== null) return { amount: intent.amount, unit: intent.unit ?? intent.pet.portion?.unit ?? DEFAULT_PORTION.unit };
  return intent.pet.portion ?? DEFAULT_PORTION;
}

/** The preview card's title and detail line for a quick-add suggestion. */
export function describeIntent(intent: QuickAddIntent, self: QuickAddMember | null): { title: string; detail: string } {
  switch (intent.kind) {
    case 'shopping':
      return {
        title: `Add ${intent.items.map((item) => (item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name)).join(', ')}`,
        detail: intent.list ? `to ${intent.list.name}` : 'No shopping list yet',
      };
    case 'feeding': {
      const portion = feedingPortion(intent);
      return { title: `Log a meal for ${intent.pet.name}`, detail: `${formatPortion(portion.amount, portion.unit)}, now` };
    }
    case 'chore': {
      if (intent.assigneeQuery && !intent.assignee) {
        const first = new Date(`${intent.dueDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const when = intent.repeat ? `repeats ${describeRepeat(intent.repeat)}, first ${first}` : `due ${first}`;
        return { title: `${intent.repeat ? 'Repeating chore' : 'Chore'}: ${intent.task}`, detail: `${when} · for which ${intent.assigneeQuery}?${intent.room ? ` · ${intent.room.name}` : ''}` };
      }
      const who = intent.assignee ?? self;
      const first = new Date(`${intent.dueDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const when = intent.repeat ? `repeats ${describeRepeat(intent.repeat)}, first ${first}` : `due ${first}`;
      return { title: `${intent.repeat ? 'Repeating chore' : 'Chore'}: ${intent.task}`, detail: `${when}${who ? ` · for ${who.name}` : ''}${intent.room ? ` · ${intent.room.name}` : ''}` };
    }
    case 'maintenance': {
      const parts = [
        intent.mileage ? `at ${intent.mileage.toLocaleString()} miles` : null,
        maintenanceTargetName(intent.target) ?? (intent.targetQuery ? `which ${intent.targetQuery}?` : 'General log'),
        'today',
      ].filter(Boolean);
      return { title: `Log maintenance: ${intent.title}`, detail: parts.join(' · ') };
    }
  }
}

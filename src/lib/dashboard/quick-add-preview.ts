/**
 * What the command palette's quick-add preview card says (H13), from the intent
 * alone, so the deterministic parser, the AI reader and the card are tested
 * together. Pure: no Firebase or React.
 */
import { DEFAULT_PORTION, formatPortion } from '../pets/care';
import type { PortionUnit } from '../pets/types';
import { describeRepeat, type MaintenanceTarget, type QuickAddIntent, type QuickAddMember } from './quick-add';

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
}: {
  intent: QuickAddIntent;
  indexLoading: boolean;
  vehicleCount: number;
  chosenTarget: MaintenanceTarget | null;
}): string | null {
  if (indexLoading) return "Loading your household's members, rooms, lists and vehicles…";
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
      const who = intent.assignee ?? self;
      const first = new Date(`${intent.dueDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const when = intent.repeat ? `repeats ${describeRepeat(intent.repeat)}, first ${first}` : `due ${first}`;
      return { title: `${intent.repeat ? 'Repeating chore' : 'Chore'}: ${intent.task}`, detail: `${when}${who ? ` · for ${who.name}` : ''}${intent.room ? ` · ${intent.room.name}` : ''}` };
    }
    case 'maintenance': {
      const parts = [
        intent.mileage ? `at ${intent.mileage.toLocaleString()} miles` : null,
        maintenanceTargetName(intent.target) ?? 'General log',
        'today',
      ].filter(Boolean);
      return { title: `Log maintenance: ${intent.title}`, detail: parts.join(' · ') };
    }
  }
}

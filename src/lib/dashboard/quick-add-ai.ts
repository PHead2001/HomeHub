/**
 * The AI fallback for quick add (H13), on the client side: what is sent to the
 * reader (`src/ai/tasks/parse-command.ts`) and how its answer becomes the same
 * `QuickAddIntent` the deterministic parser produces, so the palette shows the
 * same preview card and writes through the same code. Pure (no Firebase, no
 * React), so it is unit tested.
 *
 * Only display names leave the device, each paired with a short reference (`m1`,
 * `r1`, `v1`…) that is resolved back here; emails, ids and other fields stay local.
 */
import type { ParseCommandInput, ParseCommandOutput } from '@/ai/tasks/parse-command';
import { dayKey, startOfLocalDay } from './dates';
import {
  firstDateForRepeat,
  normalizeRepeat,
  type QuickAddContext,
  type QuickAddIntent,
  type QuickAddList,
  type QuickAddMember,
  type QuickAddPet,
  type QuickAddRepeat,
  type QuickAddRoom,
  type QuickAddVehicle,
  type Weekday,
} from './quick-add';

export type AiParseRefs = {
  members: Map<string, QuickAddMember>;
  rooms: Map<string, QuickAddRoom>;
  pets: Map<string, QuickAddPet>;
  lists: Map<string, QuickAddList>;
  vehicles: Map<string, QuickAddVehicle>;
};

const LIMITS = { members: 30, rooms: 60, pets: 30, lists: 30, vehicles: 20 } as const;
const clip = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Unnamed';

function withRefs<T extends { name: string }>(items: readonly T[], prefix: string, max: number) {
  const map = new Map<string, T>();
  const named = items.slice(0, max).map((item, index) => {
    const ref = `${prefix}${index + 1}`;
    map.set(ref, item);
    return { ref, name: clip(item.name) };
  });
  return { map, named };
}

const vehicleLabel = (vehicle: QuickAddVehicle) =>
  [vehicle.name, [vehicle.make, vehicle.model].filter(Boolean).join(' ')].filter((part) => part && part.trim()).join(' · ');

/** The reader's input for `text`, plus the references to resolve its answer. */
export function buildAiParseRequest(text: string, context: QuickAddContext): { input: ParseCommandInput; refs: AiParseRefs } {
  const members = withRefs(context.members, 'm', LIMITS.members);
  const rooms = withRefs(context.rooms ?? [], 'r', LIMITS.rooms);
  const pets = withRefs(context.pets, 'p', LIMITS.pets);
  const lists = withRefs(context.lists, 'l', LIMITS.lists);
  const vehicles = withRefs((context.vehicles ?? []).map((vehicle) => ({ ...vehicle, name: vehicleLabel(vehicle) || vehicle.name })), 'v', LIMITS.vehicles);
  // Map back to the original vehicle records (the label is only for the model).
  const vehicleMap = new Map<string, QuickAddVehicle>();
  vehicles.map.forEach((_, ref) => {
    const index = Number(ref.slice(1)) - 1;
    const original = context.vehicles?.[index];
    if (original) vehicleMap.set(ref, original);
  });
  return {
    input: {
      text: text.trim().replace(/\s+/g, ' ').slice(0, 200),
      today: dayKey(context.now),
      members: members.named,
      rooms: rooms.named,
      pets: pets.named,
      lists: lists.named,
      vehicles: vehicles.named,
    },
    refs: { members: members.map, rooms: rooms.map, pets: pets.map, lists: lists.map, vehicles: vehicleMap },
  };
}

/**
 * Offer "Read it with AI" when the deterministic parser found nothing, or only a
 * bare-words shopping guess, for something that reads like a sentence.
 */
export function shouldOfferAiParse(text: string, intent: QuickAddIntent | null): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6 || trimmed.length > 200 || trimmed.split(/\s+/).length < 2) return false;
  return intent === null || (intent.kind === 'shopping' && !intent.explicit);
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function toRepeat(repeat: NonNullable<NonNullable<ParseCommandOutput['chore']>['repeat']>): QuickAddRepeat | null {
  if (repeat.frequency === 'daily') return { frequency: 'daily' };
  if (repeat.frequency === 'monthly') return repeat.dayOfMonth ? { frequency: 'monthly', dayOfMonth: repeat.dayOfMonth } : null;
  return repeat.dayOfWeek !== undefined ? { frequency: repeat.frequency, dayOfWeek: repeat.dayOfWeek as Weekday } : null;
}

/**
 * The palette intent for the reader's answer, or null for "none" (the palette then
 * says it could not read the sentence and stays on search). References resolve to
 * the member's own records; an unresolvable pet means no intent. A due date in the
 * past is moved to today.
 */
export function intentFromAiParse(output: ParseCommandOutput, refs: AiParseRefs, context: QuickAddContext): QuickAddIntent | null {
  const today = dayKey(startOfLocalDay(context.now));
  if (output.kind === 'chore' && output.chore) {
    const asked = output.chore.repeat ? toRepeat(output.chore.repeat) : null;
    const normalized = asked ? normalizeRepeat(asked) : null;
    const repeat = normalized?.repeat ?? null;
    const due = repeat
      ? dayKey(firstDateForRepeat(repeat, context.now))
      : output.chore.dueDate && DAY.test(output.chore.dueDate) && output.chore.dueDate >= today ? output.chore.dueDate : today;
    return {
      kind: 'chore',
      task: capitalize(output.chore.task.trim()).slice(0, 100),
      dueDate: due,
      assignee: (output.chore.assigneeRef && refs.members.get(output.chore.assigneeRef)) || null,
      repeat,
      room: (output.chore.roomRef && refs.rooms.get(output.chore.roomRef)) || null,
      repeatNote: normalized?.note ?? null,
    };
  }
  if (output.kind === 'maintenance' && output.maintenance) {
    const vehicle = output.maintenance.vehicleRef ? refs.vehicles.get(output.maintenance.vehicleRef) : undefined;
    return {
      kind: 'maintenance',
      title: capitalize(output.maintenance.title.trim()).slice(0, 100),
      mileage: output.maintenance.mileage ?? null,
      target: vehicle ? { kind: 'vehicle', vehicle } : null,
    };
  }
  if (output.kind === 'shopping' && output.shopping) {
    const list = (output.shopping.listRef && refs.lists.get(output.shopping.listRef))
      || context.lists.find((candidate) => candidate.type === 'Grocery')
      || context.lists[0]
      || null;
    return {
      kind: 'shopping',
      items: output.shopping.items.map((item) => ({ name: capitalize(item.name.trim()), quantity: item.quantity })),
      list,
      explicit: true,
    };
  }
  if (output.kind === 'feeding' && output.feeding) {
    const pet = refs.pets.get(output.feeding.petRef);
    if (!pet) return null;
    return { kind: 'feeding', pet, amount: output.feeding.amount ?? null, unit: output.feeding.unit ?? null };
  }
  return null;
}

export type RevisionGuard = {
  /** Starts a request: returns its revision and makes every older one stale. */
  next: () => number;
  /** Makes every outstanding request stale (the input or the preview changed). */
  invalidate: () => void;
  /** True while `revision` is still the latest and nothing invalidated it. */
  isCurrent: (revision: number) => boolean;
};

/**
 * Ties async AI reads to the input they were made for: only the latest request,
 * and only until the input or the open preview changes, may update the palette.
 */
export function createRevisionGuard(): RevisionGuard {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current;
    },
    invalidate: () => {
      current += 1;
    },
    isCurrent: (revision) => revision === current,
  };
}

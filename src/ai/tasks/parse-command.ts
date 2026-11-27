import { z } from 'zod';
import { openAiModels } from '@/ai/model-config';
import { generateStructured, parseTaskInput, parseTaskOutput } from '@/ai/structured-generation';
import { redactPersonal } from '@/ai/redact';
import { mileageInText, portionInText } from '@/lib/dashboard/quick-add-numbers';
import { findDate } from '@/lib/dashboard/quick-add';
import { dayKey } from '@/lib/dashboard/dates';

/**
 * AI reader for the command palette's quick add (H13). Used only as a fallback,
 * for a sentence the deterministic parser (`parseQuickAdd`) could not read, and
 * only after the member picks "Read it with AI". It never writes anything: it
 * returns one structured intent that the palette maps to the same preview card the
 * deterministic parser produces, and nothing is saved until the member confirms.
 *
 * Household names reach the model only as short opaque references (`m1`, `r2`,
 * `v1`…) next to display names; no emails, ids or other fields. The output is
 * sanitized against the supplied references and the kinds the member may create,
 * and a mileage is kept only when those digits are in the member's own sentence.
 */

export const PARSE_COMMAND_KINDS = ['chore', 'maintenance', 'shopping', 'feeding'] as const;
export type ParseCommandKind = (typeof PARSE_COMMAND_KINDS)[number];

const PORTION_UNITS = ['Cups', 'Cans', 'Scoops', 'Other'] as const;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const named = (prefix: string, max: number) => z.array(z.object({
  ref: z.string().regex(new RegExp(`^${prefix}\\d{1,3}$`)),
  name: z.string().trim().min(1).max(80),
})).max(max);

export const ParseCommandInputSchema = z.object({
  text: z.string().trim().min(2).max(200),
  /** Today in the member's time zone (yyyy-MM-dd), for "tomorrow" or "Friday". */
  today: z.string().regex(DAY_KEY),
  members: named('m', 30),
  rooms: named('r', 60),
  pets: named('p', 30),
  lists: named('l', 30),
  vehicles: named('v', 20),
});
export type ParseCommandInput = z.infer<typeof ParseCommandInputSchema>;

const Ref = z.string().trim().min(1).max(8);

export const ParseCommandOutputSchema = z.object({
  kind: z.enum(['chore', 'maintenance', 'shopping', 'feeding', 'none']),
  chore: z.object({
    task: z.string().trim().min(1).max(100),
    /** yyyy-MM-dd; omitted for "today" or when a repeat sets the first day. */
    dueDate: z.string().trim().max(10).optional(),
    repeat: z.object({
      frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
      dayOfWeek: z.number().int().min(0).max(6).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
    }).optional(),
    assigneeRef: Ref.optional(),
    roomRef: Ref.optional(),
  }).optional(),
  maintenance: z.object({
    title: z.string().trim().min(1).max(100),
    mileage: z.number().int().min(1).max(1_999_999).optional(),
    vehicleRef: Ref.optional(),
  }).optional(),
  shopping: z.object({
    items: z.array(z.object({
      name: z.string().trim().min(1).max(120),
      quantity: z.number().int().min(1).max(99),
    })).min(1).max(20),
    listRef: Ref.optional(),
  }).optional(),
  feeding: z.object({
    petRef: Ref,
    amount: z.number().min(0.05).max(50).optional(),
    unit: z.enum(PORTION_UNITS).optional(),
  }).optional(),
});
export type ParseCommandOutput = z.infer<typeof ParseCommandOutputSchema>;

const NONE: ParseCommandOutput = { kind: 'none' };

const validDay = (value: string | undefined): string | undefined => {
  if (!value || !DAY_KEY.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : undefined;
};

/**
 * The model's numbers and days are kept only when the member's own sentence states
 * them (QA-7): a mileage as digits or "48k" (`mileageInText`), a portion as the Pets
 * parser reads it or as written (`portionInText`), a due date that the deterministic
 * date reader derives from the sentence, and a repeat whose day the sentence names.
 */
const todayAt = (today: string) => {
  const [year, month, day] = today.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
};
const dueDateInText = (dueDate: string, text: string, today: string) => {
  const found = findDate(text, todayAt(today));
  if (found) return dayKey(found.date) === dueDate;
  return dueDate === today && /\b(?:today|tonight)\b/i.test(text);
};
const WEEKDAY_WORDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const repeatInText = (repeat: { frequency: string; dayOfWeek?: number; dayOfMonth?: number }, text: string) => {
  const lower = text.toLowerCase();
  if (repeat.frequency === 'daily') return /\b(?:day|daily|days|nightly|night|morning|evening)\b/.test(lower);
  if (repeat.frequency === 'monthly') return repeat.dayOfMonth !== undefined && new RegExp(`(?<!\\d)${repeat.dayOfMonth}(?!\\d)`).test(lower);
  if (repeat.dayOfWeek === undefined) return false;
  if (repeat.dayOfWeek === 6 && /\bweekends?\b/.test(lower)) return true;
  return new RegExp(`\\b${WEEKDAY_WORDS[repeat.dayOfWeek]}`).test(lower);
};

/**
 * Keeps only what the member may create and what refers to supplied records:
 * unknown references are dropped (an unknown pet makes the result "none"), a
 * repeat without its day is dropped, dates must be real calendar days, and a
 * mileage the sentence does not contain is dropped. Only the chosen kind's part
 * is returned.
 */
export function sanitizeParseCommandOutput(
  output: ParseCommandOutput,
  input: ParseCommandInput,
  allowed: readonly ParseCommandKind[],
): ParseCommandOutput {
  if (output.kind === 'none' || !allowed.includes(output.kind)) return NONE;
  const has = (list: Array<{ ref: string }>, ref: string | undefined) => (ref && list.some((entry) => entry.ref === ref) ? ref : undefined);

  if (output.kind === 'chore' && output.chore) {
    const { repeat } = output.chore;
    const keptRepeat = repeat && (
      repeat.frequency === 'daily'
      || ((repeat.frequency === 'weekly' || repeat.frequency === 'biweekly') && repeat.dayOfWeek !== undefined)
      || (repeat.frequency === 'monthly' && repeat.dayOfMonth !== undefined)
    ) && repeatInText(repeat, input.text) ? {
        frequency: repeat.frequency,
        ...(repeat.frequency === 'weekly' || repeat.frequency === 'biweekly' ? { dayOfWeek: repeat.dayOfWeek } : {}),
        ...(repeat.frequency === 'monthly' ? { dayOfMonth: repeat.dayOfMonth } : {}),
      } : undefined;
    const asked = validDay(output.chore.dueDate);
    const dueDate = asked && dueDateInText(asked, input.text, input.today) ? asked : undefined;
    const assigneeRef = has(input.members, output.chore.assigneeRef);
    const roomRef = has(input.rooms, output.chore.roomRef);
    return {
      kind: 'chore',
      chore: {
        task: output.chore.task,
        ...(dueDate ? { dueDate } : {}),
        ...(keptRepeat ? { repeat: keptRepeat } : {}),
        ...(assigneeRef ? { assigneeRef } : {}),
        ...(roomRef ? { roomRef } : {}),
      },
    };
  }
  if (output.kind === 'maintenance' && output.maintenance) {
    const { mileage } = output.maintenance;
    const vehicleRef = has(input.vehicles, output.maintenance.vehicleRef);
    return {
      kind: 'maintenance',
      maintenance: {
        title: output.maintenance.title,
        ...(mileage !== undefined && mileageInText(mileage, input.text) ? { mileage } : {}),
        ...(vehicleRef ? { vehicleRef } : {}),
      },
    };
  }
  if (output.kind === 'shopping' && output.shopping) {
    const listRef = has(input.lists, output.shopping.listRef);
    return { kind: 'shopping', shopping: { items: output.shopping.items, ...(listRef ? { listRef } : {}) } };
  }
  if (output.kind === 'feeding' && output.feeding) {
    const petRef = has(input.pets, output.feeding.petRef);
    if (!petRef) return NONE;
    const { amount, unit } = output.feeding;
    // A portion the sentence does not state is dropped with its unit: the pet's usual portion is used.
    const stated = amount !== undefined && portionInText(amount, input.text);
    return { kind: 'feeding', feeding: { petRef, ...(stated ? { amount } : {}), ...(stated && unit ? { unit } : {}) } };
  }
  return NONE;
}

export async function parseCommandFlow(
  candidateInput: ParseCommandInput,
  allowed: readonly ParseCommandKind[],
): Promise<ParseCommandOutput> {
  const parsed = parseTaskInput(ParseCommandInputSchema, candidateInput);
  // Emails, phone numbers and street addresses never reach the model (QA-7), even
  // from a client that skipped its own redaction.
  const input = { ...parsed, text: redactPersonal(parsed.text) };
  if (allowed.length === 0) return NONE;
  const result = await generateStructured({
    flowName: 'command-parse',
    input: { ...input, allowedKinds: allowed },
    model: openAiModels.default,
    outputSchema: ParseCommandOutputSchema,
    timeoutMs: 8_000,
    maxOutputTokens: 400,
    taskInstruction: [
      'Read one short household request and return the single thing it asks to add, or kind "none".',
      'Choose kind only from allowedKinds. Fill only the object for that kind.',
      'chore: a task to do, with dueDate (yyyy-MM-dd, relative to today) or a repeat (weekly/biweekly need dayOfWeek 0=Sunday; monthly needs dayOfMonth), and assigneeRef/roomRef only when the text names that member or room.',
      'maintenance: a service or repair that was done, with mileage only when the text gives an odometer reading, and vehicleRef only when the text names that vehicle.',
      'shopping: items to buy with quantities, and listRef only when the text names that list. feeding: a meal given to a named pet.',
      'Use only references from the supplied lists. Never invent numbers, names or references. Return only the requested structured output.',
    ].join('\n'),
  });
  return parseTaskOutput(ParseCommandOutputSchema, sanitizeParseCommandOutput(result.output, input, allowed));
}

/**
 * Pets views (P4: PE-9, PE-13), pure: the status band a board card shows, the
 * layout a screen gets, and how the board fills the screen. Read by
 * `src/components/pets/pet-views.tsx`; unit tested.
 */
import { feedingCountLabel, feedingHeadline, type FeedingStatus, type MedicationDue } from './care';
import { mealAttention, mealCountLabel, mealHeadline, type MealStatus } from './meal-plan';
import { medicationAttention } from './medication-course';

/**
 * The band's tone: `overdue` red (a medication dose is overdue), `due` amber (a
 * confirmed meal is due or was missed today), `fed` green (today's meals or
 * feedings are done), `neutral` (nothing due yet, an off-day, or a pet without
 * confirmed meal times that is not done: never amber, D-P3), `unknown` (the
 * history is loading or could not be read: no claim either way).
 */
export type BoardTone = 'overdue' | 'due' | 'fed' | 'neutral' | 'unknown';

export type BoardStatus = {
  tone: BoardTone;
  /** The band's text label, so colour is never the only signal (PE-9b). */
  label: string;
  /** The feeding status, the card's most prominent text (PE-9a). */
  line: string;
  /** A smaller second line: today's count or who fed last. */
  detail: string | null;
  /** The overdue medication, when the band is red for it. */
  medication: string | null;
};

export type BoardInput = {
  meal: MealStatus | null;
  status: FeedingStatus | null;
  dues: readonly MedicationDue[];
  feedingsLoading: boolean;
  feedingsFailed: boolean;
  medicationFailed: boolean;
  now: Date;
  timeZone?: string | null;
};

/** The band and lines of one pet on the board, from the shared slot status (P2) and medication attention (P3). */
export function boardStatus(input: BoardInput): BoardStatus {
  const medication = input.medicationFailed ? null : medicationAttention(input.dues);
  if (input.feedingsLoading) {
    return { tone: medication ? 'overdue' : 'unknown', label: medication ? 'Medication overdue' : 'Checking', line: 'Checking feedings…', detail: null, medication };
  }
  if (input.feedingsFailed || !input.meal || !input.status) {
    return { tone: medication ? 'overdue' : 'unknown', label: medication ? 'Medication overdue' : 'Unavailable', line: 'Feeding status unavailable', detail: null, medication };
  }
  const { meal, status } = input;
  let tone: BoardTone;
  let label: string;
  let line: string;
  let detail: string | null;
  if (meal.kind === 'slots') {
    line = mealHeadline(meal);
    detail = status.last ? feedingHeadline(status, input.now, input.timeZone) : mealCountLabel(meal);
    const attention = mealAttention(meal);
    if (meal.due) {
      tone = 'due';
      label = 'Meal due';
    } else if (attention) {
      tone = 'due';
      label = 'Meal missed';
    } else if (meal.complete) {
      tone = 'fed';
      label = 'Fed';
    } else {
      tone = 'neutral';
      label = meal.offDay ? 'No meals today' : 'Not due yet';
    }
  } else {
    const done = status.complete && Boolean(status.perDay);
    line = done ? 'All fed today' : feedingHeadline(status, input.now, input.timeZone);
    detail = feedingCountLabel(status);
    tone = done ? 'fed' : 'neutral';
    label = done ? 'Fed' : status.fedToday > 0 ? 'Fed today' : status.nonDaily ? 'No daily plan' : 'Not fed today';
  }
  if (medication) return { tone: 'overdue', label: 'Medication overdue', line, detail, medication };
  return { tone, label, line, detail, medication: null };
}

/* ------------------------------------------------------------------------- */
/* Layout                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Which view a screen gets: `board` on every wide landscape screen (D-P1: at
 * least 1024 CSS px wide and wider than tall, personal accounts included),
 * `rows` on phones (narrower than 640 px, PE-13a), `grid` otherwise.
 */
export type PetsLayout = 'board' | 'rows' | 'grid';

export const BOARD_QUERY = '(min-width: 1024px) and (orientation: landscape)';
export const ROWS_QUERY = '(max-width: 639px)';

export function petsLayoutFor(matches: { board: boolean; rows: boolean }): PetsLayout {
  if (matches.rows) return 'rows';
  return matches.board ? 'board' : 'grid';
}

/** Up to this many pets fit the board without scrolling (D-P14); more scroll inside the board. */
export const BOARD_FIT = 6;

/**
 * The board's grid for `count` pets: one or two pets share the screen (PE-9d),
 * three in a row, four as two by two, five and six as three by two; past six the
 * board keeps three columns and scrolls inside itself (`scroll`).
 */
export function boardGrid(count: number): { columns: number; rows: number; scroll: boolean } {
  if (count <= 0) return { columns: 1, rows: 1, scroll: false };
  if (count <= 3) return { columns: count, rows: 1, scroll: false };
  if (count === 4) return { columns: 2, rows: 2, scroll: false };
  if (count <= BOARD_FIT) return { columns: 3, rows: 2, scroll: false };
  return { columns: 3, rows: Math.ceil(count / 3), scroll: true };
}

/* ------------------------------------------------------------------------- */
/* Hold caption (PE-12a, D-P17)                                               */
/* ------------------------------------------------------------------------- */

/** Local storage key: set after the first successful hold or a dismiss (remembered per browser). */
export const HOLD_CAPTION_KEY = 'homehub.pets.holdCaptionDone';

/** The caption shows on touch screens, to members who may feed, until it is done. */
export function showHoldCaption(input: { coarse: boolean; canFeed: boolean; done: boolean; hasPets: boolean }): boolean {
  return input.coarse && input.canFeed && input.hasPets && !input.done;
}

/* ------------------------------------------------------------------------- */
/* Reduced-motion hold ring (PE-20a)                                          */
/* ------------------------------------------------------------------------- */

/**
 * Under reduced motion the ring fills in three discrete steps, never
 * continuously: a third after a third of the hold, two thirds after two
 * thirds, full when it completes.
 */
export function steppedHoldProgress(progress: number, steps = 3): number {
  if (!(progress > 0)) return 0;
  if (progress >= 1) return 1;
  return Math.floor(progress * steps) / steps;
}

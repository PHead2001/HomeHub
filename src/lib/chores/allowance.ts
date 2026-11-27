/**
 * Allowance from points (CH-29): reading the owner's rate. Pure.
 */
import { MAX_CENTS_PER_POINT } from '../../../functions/src/shared/chore-points';

/** Whole cents per point typed by an owner, or null when it is not 0-100. */
export function parseCentsPerPoint(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const cents = Number(trimmed);
  return cents <= MAX_CENTS_PER_POINT ? cents : null;
}

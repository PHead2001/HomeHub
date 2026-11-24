// Warranty countdown (H10): days left out of the warranty term, for the ring on
// each asset card. Pure and day-based (household-local `YYYY-MM-DD` strings), so
// it is unit tested. Documented in docs/modules/maintenance-center/README.md.
import { addDays, diffDays, isDayString } from '../../../functions/src/shared/calendar';

/** Term used when no start date is known: a one-year warranty ending on the expiration date. */
export const WARRANTY_FALLBACK_DAYS = 365;

export type WarrantyTermSource = 'purchase' | 'fallback' | 'lifetime';

export type WarrantyCountdown = {
  /** Whole days from today until the warranty ends (0 on the last day; negative once ended). */
  daysLeft: number;
  /** Length of the term in days (at least 1). */
  termDays: number;
  /** Share of the term left, 0..1 (0 once ended). */
  fraction: number;
  /** Where the term's start came from: the purchase date, or the 1-year fallback. */
  source: WarrantyTermSource;
  expired: boolean;
  /** A lifetime warranty (asset `warrantyLifetime`): never ends; the ring reads "Lifetime". */
  lifetime?: boolean;
};

/** A lifetime warranty's countdown: a full ring that never runs down. */
export const LIFETIME_WARRANTY: WarrantyCountdown = Object.freeze({
  daysLeft: Number.POSITIVE_INFINITY,
  termDays: 1,
  fraction: 1,
  source: 'lifetime',
  expired: false,
  lifetime: true,
});

/**
 * The countdown for a warranty ending on `expiration` (inclusive), seen on `today`.
 * HomeHub stores no warranty start date, so the term starts at the purchase date
 * when it is known and earlier than the expiration; otherwise the term is assumed
 * to be one year. Returns null without a valid expiration date.
 */
export function warrantyCountdown(
  asset: { warrantyExpiration?: string | null; purchaseDate?: string | null; warrantyLifetime?: boolean | null },
  today: string,
): WarrantyCountdown | null {
  if (asset.warrantyLifetime === true) return LIFETIME_WARRANTY;
  const end = asset.warrantyExpiration?.slice(0, 10);
  if (!isDayString(end) || !isDayString(today)) return null;
  const purchase = asset.purchaseDate?.slice(0, 10);
  const usePurchase = isDayString(purchase) && diffDays(end, purchase) > 0;
  const start = usePurchase ? purchase : addDays(end, -WARRANTY_FALLBACK_DAYS);
  const termDays = Math.max(1, diffDays(end, start));
  const daysLeft = diffDays(end, today);
  const fraction = daysLeft < 0 ? 0 : Math.min(1, daysLeft / termDays);
  return { daysLeft, termDays, fraction, source: usePurchase ? 'purchase' : 'fallback', expired: daysLeft < 0 };
}

/** Plain text for the ring's accessible name and the card, e.g. "Warranty: 9 days left of 1,551". */
export function warrantyCountdownText(countdown: WarrantyCountdown): string {
  if (countdown.lifetime) return 'Lifetime warranty';
  if (countdown.expired) return 'Warranty ended';
  if (countdown.daysLeft === 0) return 'Warranty ends today';
  const days = countdown.daysLeft === 1 ? '1 day' : `${countdown.daysLeft.toLocaleString('en-US')} days`;
  return `Warranty: ${days} left of ${countdown.termDays.toLocaleString('en-US')}`;
}

/**
 * The visible caption under a card's warranty ring (MA-17, MA-23): "Warranty · 198 days",
 * "Warranty · 1 day", "Warranty ends today", "Warranty ended". Null for a lifetime
 * warranty, whose pill already reads "Lifetime".
 */
export function warrantyCaption(countdown: WarrantyCountdown): string | null {
  if (countdown.lifetime) return null;
  if (countdown.expired) return 'Warranty ended';
  if (countdown.daysLeft === 0) return 'Warranty ends today';
  return `Warranty · ${countdown.daysLeft === 1 ? '1 day' : `${countdown.daysLeft.toLocaleString('en-US')} days`}`;
}

/** Short label inside the ring: days up to 999, then years; "Lifetime" for a lifetime warranty. */
export function warrantyRingLabel(countdown: WarrantyCountdown): string {
  if (countdown.lifetime) return 'Lifetime';
  if (countdown.expired) return '0d';
  if (countdown.daysLeft < 1000) return `${countdown.daysLeft}d`;
  return `${Math.floor(countdown.daysLeft / 365)}y`;
}

// Device codes: format, setup URL (code in the fragment), and the tablet's refusal copy.
// Device codes use the member-invite alphabet and normalization (src/lib/invite-codes.ts),
// but live in their own collection (`deviceCodes`) and flow. See docs/modules/devices/README.md.
import { normalizeInviteCode } from '@/lib/invite-codes';
import type { RedeemRefusal } from './types';

/** A device code lasts 15 minutes from the server's creation time. */
export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
export const DEVICE_CODE_TTL_MINUTES = DEVICE_CODE_TTL_MS / 60000;

/** At most this many unexpired, unused codes per household. */
export const MAX_LIVE_DEVICE_CODES = 10;

/** `XXXX-XXXX-XX`, typed loosely or not; null when it cannot be a code. */
export const normalizeDeviceCode = (input: string): string | null => normalizeInviteCode(input);

export const SETUP_PATH = '/setup';

/**
 * The QR's setup link. The code is in the fragment, so it never reaches the server,
 * proxies or logs; the setup page reads it and removes it from the address bar.
 */
export const deviceSetupUrl = (origin: string, code: string): string => `${origin.replace(/\/+$/, '')}${SETUP_PATH}#code=${encodeURIComponent(code)}`;

/** The code in a setup URL's fragment (`#code=ABCD-EFGH-JK`), normalized, or null. */
export const codeFromSetupFragment = (hash: string | null | undefined): string | null => {
  if (!hash) return null;
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of fragment.split('&')) {
    const [key, ...rest] = part.split('=');
    if (key !== 'code') continue;
    let value = rest.join('=');
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return normalizeDeviceCode(value);
  }
  return null;
};

/** The code a scanned QR holds: a setup URL of this origin, or a bare code. */
export const codeFromScan = (text: string, origin: string): string | null => {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.origin !== origin || url.pathname !== SETUP_PATH) return null;
    return codeFromSetupFragment(url.hash);
  } catch {
    return normalizeDeviceCode(trimmed);
  }
};

/** What the tablet says for each refusal. */
export const REDEEM_REFUSAL_COPY: Record<RedeemRefusal, string> = {
  not_found: "That code wasn't found. Check it and try again.",
  wrong_kind: "That's an invite for a person. Use Join a household.",
  expired: 'That code has expired. Ask for a new one.',
  used: 'That code has already been used. Tell the person who made it, then ask for a new one.',
  revoked: 'That code was cancelled. Ask for a new one.',
  creator_lost_access: 'The person who made this code can no longer add tablets. Ask an owner or admin for a new one.',
  superseded: 'This tablet was changed since the code was made. Ask for a new code.',
  not_repairable: 'That tablet was removed. Ask for a new code.',
  household_deleting: 'That household is being deleted.',
  household_needs_upkeep: "This household isn't ready for wall tablets yet. Ask an owner to try again later.",
  rate_limited: 'Too many tries. Wait a minute, then try again.',
  app_check_failed: "This browser couldn't be verified. Reload the page and try again.",
  invalid_input: 'Enter the 10-character code, for example ABCD-EFGH-JK.',
  unavailable: "Wall tablets aren't available yet.",
  failed: "Something went wrong on our side. Try again in a moment.",
};

/** Member-invite redemption's message for a device code typed in Join a household. */
export const DEVICE_CODE_AS_INVITE_MESSAGE = "That's a wall-tablet code. Use Set up a wall tablet.";

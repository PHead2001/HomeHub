// No email reaches a wall tablet, and none is kept in the server's op ledger
// (docs/modules/devices/README.md; WT-10e, design 10.1). Pure.

import { publicDisplayName } from '@/lib/member-directory';

/**
 * A copy without any `…Email` field, at any depth, and with every `…Name` string as a
 * public name (an email-valued name becomes empty). Used for every answer to a tablet and
 * for every op-ledger summary before it is stored (the gate's finalize).
 */
export const withoutEmails = <T,>(value: T): T => {
  if (Array.isArray(value)) return value.map(withoutEmails) as T;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/email/i.test(key)) continue;
    out[key] = /name$/i.test(key) && typeof child === 'string' ? publicDisplayName(child, '') : withoutEmails(child);
  }
  return out as T;
};

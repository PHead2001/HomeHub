// Invite codes are 10 characters shown as XXXX-XXXX-XX. People type them with
// or without dashes, in any case, and sometimes with spaces.
const INVITE_ALPHABET = /^[A-Z0-9]{10}$/;

/** The letters and digits generated codes use (no 0/O, 1/I): member invites and device codes. */
export const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const normalizeInviteCode = (input: string): string | null => {
  const compact = (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!INVITE_ALPHABET.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
};

// Invite expiry is stored as a Firestore Timestamp (older codes used ISO strings).
export const inviteDateToIso = (value: unknown): string => {
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
};

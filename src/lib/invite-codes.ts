// Invite codes are 10 characters shown as XXXX-XXXX-XX. People type them with
// or without dashes, in any case, and sometimes with spaces.
const INVITE_ALPHABET = /^[A-Z0-9]{10}$/;

export const normalizeInviteCode = (input: string): string | null => {
  const compact = (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!INVITE_ALPHABET.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
};

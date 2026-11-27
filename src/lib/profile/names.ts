/**
 * What the app calls the signed-in person (PR-3). Profile edits the display name
 * (and, later, a nickname), never Google's first name, so a person who renamed
 * themselves "Mom" is greeted as Mom. Google's `firstName` is only the last
 * fallback for profiles without a display name. Pure; unit tested.
 */
export type NamedProfile = {
  nickname?: string | null;
  displayName?: string | null;
  firstName?: string | null;
};

const usable = (value: string | null | undefined): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && !/\S+@\S+/.test(trimmed) ? trimmed : '';
};

/** The name for the dashboard greeting, or null when there is none (never an email). */
export function greetingNameFor(profile: NamedProfile | null | undefined): string | null {
  if (!profile) return null;
  return usable(profile.nickname) || usable(profile.displayName) || usable(profile.firstName) || null;
}

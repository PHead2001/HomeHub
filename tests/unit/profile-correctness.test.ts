import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_APPEARANCE, type AppearancePreferences } from '../../src/lib/theme/appearance';
import { changedSyncedKeys, dropPending, reconcileProfileTheme, storedSyncedValues, themeWrite } from '../../src/lib/theme/theme-sync';
import { mergeProfilePatch } from '../../src/lib/auth/profile-patch';
import { greetingNameFor } from '../../src/lib/profile/names';

const prefs = (patch: Partial<AppearancePreferences> = {}): AppearancePreferences => ({ ...DEFAULT_APPEARANCE, ...patch });
const fullTheme = { version: 2, mode: 'dark', darkPreset: 'midnight', lightPreset: 'light', reduceMotion: false };

describe('cross-device theme writes (PR-6)', () => {
  it('lists only the synced keys that changed', () => {
    assert.deepEqual(changedSyncedKeys(prefs(), prefs({ reduceMotion: true, sound: true, textScale: 130 })), ['reduceMotion']);
    assert.deepEqual(changedSyncedKeys(prefs(), prefs()), []);
  });

  it('writes only the changed keys into a complete stored theme', () => {
    assert.deepEqual(themeWrite(fullTheme, prefs({ reduceMotion: true }), ['reduceMotion']), { version: 2, reduceMotion: true });
  });

  it('writes the whole synced set when the stored theme is missing, legacy or partial', () => {
    const next = prefs({ mode: 'light' });
    const whole = { version: 2, mode: 'light', darkPreset: 'midnight', lightPreset: 'light', reduceMotion: false };
    assert.deepEqual(themeWrite(undefined, next, ['mode']), whole);
    assert.deepEqual(themeWrite({ background: 'x', accent: 'y' }, next, ['mode']), whole);
    assert.deepEqual(themeWrite({ version: 2, mode: 'dark' }, next, ['mode']), whole);
  });

  it('writes nothing when nothing changed', () => {
    assert.equal(themeWrite(fullTheme, prefs(), []), null);
  });

  it('reads only valid keys a stored theme holds, never defaults', () => {
    assert.deepEqual(storedSyncedValues({ version: 2, mode: 'light', darkPreset: 'nope' }), { mode: 'light' });
    assert.deepEqual(storedSyncedValues({ background: 'x' }), {});
    assert.deepEqual(storedSyncedValues(null), {});
  });

  it('applies another device\'s change to this page', () => {
    const { apply, pending } = reconcileProfileTheme(prefs(), { ...fullTheme, darkPreset: 'forest' }, {});
    assert.deepEqual(apply, { darkPreset: 'forest' });
    assert.deepEqual(pending, {});
  });

  it('does not revert a key this device just wrote before its echo arrives', () => {
    // The tablet turned Reduce motion on; an older snapshot (still off) arrives first.
    const local = prefs({ reduceMotion: true });
    const first = reconcileProfileTheme(local, fullTheme, { reduceMotion: true });
    assert.deepEqual(first.apply, {});
    assert.deepEqual(first.pending, { reduceMotion: true });
    // The echo acknowledges it.
    const second = reconcileProfileTheme(local, { ...fullTheme, reduceMotion: true }, first.pending);
    assert.deepEqual(second.apply, {});
    assert.deepEqual(second.pending, {});
  });

  it('a phone preset change is not reverted by a tablet toggling Reduce motion', () => {
    // The phone changed the dark preset; the tablet, with a stale copy, toggles Reduce motion.
    const tabletWrite = themeWrite(fullTheme, prefs({ reduceMotion: true }), ['reduceMotion']);
    assert.ok(tabletWrite && !('darkPreset' in tabletWrite));
    const stored = { ...fullTheme, darkPreset: 'hearth', ...tabletWrite };
    assert.equal(stored.darkPreset, 'hearth');
  });

  it('drops only pending values that still match a failed write', () => {
    assert.deepEqual(dropPending({ mode: 'light', reduceMotion: true }, { mode: 'light' }), { reduceMotion: true });
    assert.deepEqual(dropPending({ mode: 'system' }, { mode: 'light' }), { mode: 'system' });
  });
});

describe('profile patches merge like the Firestore write (PR-6)', () => {
  it('merges nested maps key by key', () => {
    const before = { displayName: 'A', theme: fullTheme, choreSettings: { reminderEnabled: true, reminderTime: '17:00' } };
    const after = mergeProfilePatch(before, { theme: { version: 2, reduceMotion: true } as never });
    assert.deepEqual(after.theme, { ...fullTheme, reduceMotion: true });
    assert.equal(after.displayName, 'A');
    assert.equal(after.choreSettings, before.choreSettings);
  });

  it('replaces non-map values and sets new maps as given', () => {
    assert.deepEqual(mergeProfilePatch({ theme: null as unknown }, { theme: { version: 2 } }), { theme: { version: 2 } });
    assert.deepEqual(mergeProfilePatch({ displayName: 'A' }, { displayName: 'B' }), { displayName: 'B' });
  });
});

describe('the dashboard greeting uses the name chosen in Profile (PR-3)', () => {
  it('prefers the display name over Google\'s first name', () => {
    assert.equal(greetingNameFor({ firstName: 'Patricia', displayName: 'Mom' }), 'Mom');
  });

  it('prefers a nickname when there is one', () => {
    assert.equal(greetingNameFor({ nickname: 'Big Al', firstName: 'Alan', displayName: 'Alan Smith' }), 'Big Al');
  });

  it('falls back to the first name, never an email', () => {
    assert.equal(greetingNameFor({ firstName: 'Sam', displayName: '  ' }), 'Sam');
    assert.equal(greetingNameFor({ displayName: 'sam@example.test', firstName: '' }), null);
    assert.equal(greetingNameFor(null), null);
  });
});

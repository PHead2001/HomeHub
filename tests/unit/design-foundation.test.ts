import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { spring } from 'motion';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  appearanceFromProfile,
  parseAppearance,
  profileAppearance,
  resolvePresetId,
  themeBootstrapScript,
} from '../../src/lib/theme/appearance';
import { PRESET_LIST, themeCss } from '../../src/lib/theme/tokens';
import { memberColor, memberColorIndex, memberColorMap } from '../../src/lib/member-colors';
import { FEEDBACK_HAPTICS, FEEDBACK_KINDS, FEEDBACK_SOUNDS, configureFeedback, playFeedback } from '../../src/lib/feedback';
import { STAGGER, sharedId, staggerDelay } from '../../src/lib/motion';

// npm scripts run from the repository root.
const root = process.cwd();

type FakeRoot = {
  attrs: Map<string, string>;
  classes: Set<string>;
};

/** Runs the pre-paint script against a minimal fake DOM. */
function runBootstrap(stored: unknown, media: { dark?: boolean; reduce?: boolean } = {}): FakeRoot {
  const attrs = new Map<string, string>([['data-theme', 'midnight']]);
  const classes = new Set(['dark', 'font-vars']);
  const meta = { content: '' };
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      classList: { add: (c: string) => classes.add(c), remove: (...c: string[]) => c.forEach((x) => classes.delete(x)) },
    },
    querySelector: () => ({ setAttribute: (_: string, v: string) => (meta.content = v) }),
  };
  const localStorage = {
    getItem: (key: string) => (key === APPEARANCE_STORAGE_KEY && stored !== undefined ? JSON.stringify(stored) : null),
  };
  const window = {
    matchMedia: (query: string) => ({
      matches: query.includes('color-scheme: dark') ? media.dark ?? false : query.includes('reduced-motion') ? media.reduce ?? false : false,
    }),
  };
  new Function('document', 'localStorage', 'window', themeBootstrapScript())(document, localStorage, window);
  attrs.set('meta-theme-color', meta.content);
  return { attrs, classes };
}

describe('theme bootstrap script (no flash before first paint)', () => {
  it('defaults to Midnight dark with no stored preference', () => {
    const { attrs, classes } = runBootstrap(undefined);
    assert.equal(attrs.get('data-theme'), 'midnight');
    assert.ok(classes.has('dark') && !classes.has('light'));
    assert.ok(classes.has('font-vars'), 'keeps unrelated classes');
    assert.equal(attrs.has('data-motion'), false);
    assert.match(attrs.get('meta-theme-color') ?? '', /^#[0-9a-f]{6}$/);
  });

  it('applies a stored light mode and preset', () => {
    const { attrs, classes } = runBootstrap({ mode: 'light', lightPreset: 'sunrise' });
    assert.equal(attrs.get('data-theme'), 'sunrise');
    assert.ok(classes.has('light') && !classes.has('dark'));
  });

  it('follows the system in System mode', () => {
    assert.equal(runBootstrap({ mode: 'system', darkPreset: 'forest' }, { dark: true }).attrs.get('data-theme'), 'forest');
    assert.equal(runBootstrap({ mode: 'system', darkPreset: 'forest' }, { dark: false }).attrs.get('data-theme'), 'light');
  });

  it('sets data-motion="reduce" from the in-app switch or the system setting', () => {
    assert.equal(runBootstrap({ reduceMotion: true }).attrs.get('data-motion'), 'reduce');
    assert.equal(runBootstrap({}, { reduce: true }).attrs.get('data-motion'), 'reduce');
  });

  it('ignores garbage and never throws', () => {
    assert.equal(runBootstrap({ mode: 'neon', darkPreset: 'light', lightPreset: 'midnight' }).attrs.get('data-theme'), 'midnight');
    assert.equal(runBootstrap('not json object').attrs.get('data-theme'), 'midnight');
  });
});

describe('appearance preferences', () => {
  it('parses defensively and round-trips the synced profile shape', () => {
    assert.deepEqual(parseAppearance(null), DEFAULT_APPEARANCE);
    const prefs = parseAppearance({ mode: 'system', darkPreset: 'hearth', lightPreset: 'sunrise', reduceMotion: true, sound: true });
    const profile = profileAppearance(prefs);
    assert.equal(profile.version, 2);
    assert.equal('sound' in profile, false, 'sound stays device-local');
    assert.deepEqual(appearanceFromProfile(profile), {
      mode: 'system',
      darkPreset: 'hearth',
      lightPreset: 'sunrise',
      reduceMotion: true,
    });
  });

  it('ignores the legacy free-color theme', () => {
    assert.equal(appearanceFromProfile({ background: '222 84% 5%', accent: '174 44% 51%', accentHex: '#4DB6AC' }), null);
  });

  it('resolves the active preset per mode', () => {
    const prefs = { mode: 'dark' as const, darkPreset: 'hearth' as const, lightPreset: 'light' as const };
    assert.equal(resolvePresetId(prefs, false), 'hearth');
    assert.equal(resolvePresetId({ ...prefs, mode: 'light' }, true), 'light');
  });

  it('emits CSS for every preset with Midnight as the :root fallback', () => {
    const css = themeCss();
    for (const preset of PRESET_LIST) assert.ok(css.includes(`[data-theme="${preset.id}"]`), preset.id);
    assert.ok(css.startsWith(':root,'));
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'tokens are HSL channels, not hex');
  });
});

describe('member colors', () => {
  it('is deterministic and in range', () => {
    assert.equal(memberColorIndex('uid-123'), memberColorIndex('uid-123'));
    for (const id of ['a', 'b', 'sam', 'jamie', 'x'.repeat(200)]) {
      const index = memberColorIndex(id);
      assert.ok(index >= 1 && index <= 8);
      assert.equal(memberColor(id).color, `hsl(var(--member-${index}))`);
    }
  });

  it('gives a household distinct colors (up to eight members)', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `member-${i}`);
    const map = memberColorMap(ids);
    assert.equal(new Set([...map.values()].map((c) => c.index)).size, 8);
    // Order of input does not matter.
    const reversed = memberColorMap([...ids].reverse());
    for (const id of ids) assert.equal(reversed.get(id)?.index, map.get(id)?.index);
  });
});

describe('feedback (sound and haptics)', () => {
  it('is a silent no-op by default and outside the browser', () => {
    configureFeedback({ sound: false, haptics: false });
    for (const kind of FEEDBACK_KINDS) assert.doesNotThrow(() => playFeedback(kind));
    configureFeedback({ sound: true, haptics: true });
    for (const kind of FEEDBACK_KINDS) assert.doesNotThrow(() => playFeedback(kind));
    configureFeedback({ sound: false, haptics: false });
  });

  it('keeps sounds short and quiet', () => {
    for (const kind of FEEDBACK_KINDS) {
      const end = Math.max(...FEEDBACK_SOUNDS[kind].map((n) => n.at + n.dur));
      assert.ok(end <= 0.4, `${kind} lasts ${end}s`);
      assert.ok(FEEDBACK_HAPTICS[kind].reduce((a, b) => a + b, 0) <= 200, `${kind} vibration is short`);
    }
  });
});

describe('motion tokens', () => {
  it('keeps the CSS spring easing in sync with motion', () => {
    const css = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8');
    const easing = String(spring(0.25, 0.2)).replace(/^\S+\s+/, '');
    assert.ok(css.includes(`--ease-spring: ${easing};`), `globals.css --ease-spring should be ${easing}`);
  });

  it('keeps staggers within budget', () => {
    assert.equal(staggerDelay(1), 0);
    for (const count of [2, 5, 10, 14, 50, 500]) {
      const delay = staggerDelay(count);
      assert.ok(delay <= STAGGER.perItem + 1e-9);
      assert.ok(delay * (count - 1) <= STAGGER.maxTotal + 1e-9);
    }
  });

  it('builds shared-element names that are valid CSS identifiers', () => {
    assert.equal(sharedId('pet', 'abc 123/x', 'photo'), 'pet-abc_123_x-photo');
  });
});

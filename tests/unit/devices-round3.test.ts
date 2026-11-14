import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { tabletListener, TABLET_DENIED_RECOVERY_MS } from '../../src/lib/devices/tablet-listener';
import { resilientListener } from '../../src/lib/dashboard/resilient-listener';
import { tabletApplication, type TabletApplication } from '../../src/lib/devices/tablet-settings-apply';
import { defaultDeviceSettings } from '../../src/lib/devices/settings';
import type { DeviceSettings } from '../../src/lib/devices/types';
import { DEFAULT_DARK_PRESET, DEFAULT_LIGHT_PRESET } from '../../src/lib/theme/tokens';

// PR #178 review round 3 (docs/modules/devices/README.md, "Tablet shell"): every tablet
// listener recovers from errors, including a permission-denied that outlasts the normal
// retries; and every device-record setting is applied from the record, never from a
// personal session's local storage.

const denied = { code: 'permission-denied' };
const env = { random: () => 0.5 };

describe('tablet listeners never stay abandoned (round 3 A)', () => {
  it('denied, denied, denied, then recovers: the tablet subscribes again and receives data', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let attempts = 0;
      const received: string[] = [];
      let deniedCalls = 0;
      const handle = tabletListener<string>((next, error) => {
        attempts += 1;
        if (attempts <= 3) error(denied);
        else next(`snapshot ${attempts}`);
        return () => undefined;
      }, { next: (value) => received.push(value), onDenied: () => { deniedCalls += 1; } }, env);
      assert.equal(attempts, 1);
      mock.timers.tick(1000); // backoff 1 s
      assert.equal(attempts, 2);
      mock.timers.tick(2000); // backoff 2 s, third denial settles
      assert.equal(attempts, 3);
      assert.equal(deniedCalls, 1, 'the caller is told (the shell then asks the server)');
      assert.deepEqual(received, []);
      mock.timers.tick(TABLET_DENIED_RECOVERY_MS - 1);
      assert.equal(attempts, 3);
      mock.timers.tick(1);
      assert.equal(attempts, 4, 'subscribed again after the recovery delay');
      assert.deepEqual(received, ['snapshot 4']);
      handle.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it('transient errors retry with backoff and a server answer resets it', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let attempts = 0;
      const received: number[] = [];
      tabletListener<number>((next, error) => {
        attempts += 1;
        if (attempts === 1) error({ code: 'unavailable' });
        else next(attempts);
        return () => undefined;
      }, { next: (value) => received.push(value) }, env);
      mock.timers.tick(1000);
      assert.deepEqual(received, [2]);
    } finally {
      mock.timers.reset();
    }
  });

  it('personal listeners keep their old behaviour: quiet after the denial retries', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let attempts = 0;
      resilientListener<string>((_next, error) => { attempts += 1; error(denied); return () => undefined; }, { next: () => undefined }, env);
      mock.timers.tick(1000);
      mock.timers.tick(2000);
      assert.equal(attempts, 3);
      mock.timers.tick(10 * 60_000);
      assert.equal(attempts, 3);
    } finally {
      mock.timers.reset();
    }
  });

  it('guard: tablet components never call onSnapshot outside tabletListener', () => {
    const dir = 'src/components/devices';
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.tsx'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      const lines = source.split('\n').filter((line) => /\bonSnapshot\(/.test(line));
      for (const line of lines) {
        assert.match(line, /\(next, error\) => onSnapshot\(/, `${file}: onSnapshot only inside a tabletListener subscribe: ${line.trim()}`);
      }
      if (lines.length > 0) assert.match(source, /tabletListener</, `${file} wraps its listeners`);
    }
  });
});

// Every leaf of the device record's settings, changed from its default, must change what
// the tablet applies, in the place named here.
type Case = { path: string; value: unknown; applied: (a: TabletApplication) => unknown; expected: unknown };
const CASES: Case[] = [
  { path: 'name', value: 'Hall tablet', applied: (a) => a.topBar.name, expected: 'Hall tablet' },
  { path: 'room', value: 'Hallway', applied: (a) => a.topBar.room, expected: 'Hallway' },
  { path: 'sections.chores', value: false, applied: (a) => [a.permissions['chores.view'], a.rail.rail.some((i) => i.key === 'chores'), a.noticeCategories.includes('chores')], expected: [false, false, false] },
  { path: 'sections.shopping', value: false, applied: (a) => [a.permissions['shopping.view'], a.rail.rail.some((i) => i.key === 'shopping'), a.noticeCategories.includes('shopping')], expected: [false, false, false] },
  { path: 'sections.pets', value: false, applied: (a) => [a.permissions['pets.view'], a.rail.rail.some((i) => i.key === 'pets'), a.noticeCategories.includes('pets')], expected: [false, false, false] },
  { path: 'sections.calendar', value: false, applied: (a) => a.rail.rail.some((i) => i.key === 'calendar'), expected: false },
  { path: 'sections.maintenance', value: false, applied: (a) => [a.permissions['maintenance.view'], a.rail.more.some((i) => i.key === 'maintenance'), a.noticeCategories.includes('maintenance')], expected: [false, false, false] },
  { path: 'startPage', value: { kind: 'pets' }, applied: (a) => a.start, expected: { kind: 'section', section: 'pets' } },
  { path: 'comfort.theme', value: 'light', applied: (a) => a.appearance.mode, expected: 'light' },
  { path: 'comfort.textScale', value: 130, applied: (a) => a.appearance.textScale, expected: 130 },
  { path: 'comfort.motion', value: 'reduced', applied: (a) => a.appearance.reduceMotion, expected: true },
  { path: 'comfort.sound', value: false, applied: (a) => a.appearance.sound, expected: false },
  { path: 'display.weather', value: true, applied: (a) => a.weather.enabled, expected: true },
  { path: 'display.weatherPlace', value: 'Austin', applied: (a) => a.weather.city, expected: 'Austin' },
  { path: 'display.temperatureUnit', value: 'F', applied: (a) => a.weather.unit, expected: 'fahrenheit' },
  { path: 'display.seasonal', value: false, applied: (a) => a.seasonal, expected: false },
  { path: 'idle.homeAfterSec', value: 300, applied: (a) => a.timers.homeAfterMs, expected: 300_000 },
  { path: 'idle.ambientAfterSec', value: 1200, applied: (a) => a.timers.ambientAfterMs, expected: 1_200_000 },
  { path: 'camera', value: 'rear', applied: (a) => a.camera, expected: 'not-used' },
];

const leafPaths = (value: unknown, prefix = ''): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  if (prefix === 'startPage') return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
};

const withValue = (settings: DeviceSettings, path: string, value: unknown): DeviceSettings => {
  const copy = structuredClone(settings) as unknown as Record<string, unknown>;
  const keys = path.split('.');
  let target = copy;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys[keys.length - 1]] = value;
  return copy as unknown as DeviceSettings;
};

describe('every device-record setting is applied from the record (round 3 B)', () => {
  const base = defaultDeviceSettings('Kitchen tablet', 'Kitchen');

  it('the table covers every setting on the record', () => {
    assert.deepEqual(CASES.map((c) => c.path).sort(), leafPaths(base).sort());
  });

  for (const testCase of CASES) {
    it(`${testCase.path} → applied on the tablet`, () => {
      assert.deepEqual(testCase.applied(tabletApplication(withValue(base, testCase.path, testCase.value))), testCase.expected);
    });
  }

  it('nothing personal carries over: fixed colour presets and no haptics', () => {
    const applied = tabletApplication(base).appearance;
    assert.equal(applied.darkPreset, DEFAULT_DARK_PRESET);
    assert.equal(applied.lightPreset, DEFAULT_LIGHT_PRESET);
    assert.equal(applied.haptics, false);
  });

  it('guard: the house reads the record\'s seasonal setting on a tablet and hides its own toggle', () => {
    const house = readFileSync('src/components/dashboard/living-house.tsx', 'utf8');
    assert.match(house, /const seasonalOn = recordSeasonal \?\? seasonalPref;/);
    assert.match(house, /recordSeasonal === undefined \? \{ on: seasonalOn, toggle: toggleSeasonal \}/);
    const shell = readFileSync('src/components/devices/tablet-shell.tsx', 'utf8');
    assert.match(shell, /seasonal: settings\.display\.seasonal/);
    assert.match(shell, /appearanceFromRecord\(settings\.comfort\)/);
    assert.match(shell, /weatherFromRecord\(settings\.display\)/);
  });
});

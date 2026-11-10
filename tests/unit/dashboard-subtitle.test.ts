import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/*
 * HP-20c: the subtitle picks its formats by its own pane width (a container query), not
 * the viewport, and wraps its whole fields instead of overflowing into the brief.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
const css = read('src/components/dashboard/dashboard.module.css');
const subtitle = read('src/components/dashboard/dashboard-subtitle.tsx');

function block(source: string, start: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unclosed ${start}`);
}

describe('dashboard subtitle (HP-20c)', () => {
  it('is an inline-size container', () => {
    assert.match(block(css, '.subtitle {'), /container-type: inline-size;/);
  });

  it('shows the long date and weather condition only from rem container widths', () => {
    assert.match(block(css, '.subtitleLongDate,\n.subtitleCondition {'), /display: none;/);
    const longDate = block(css, '@container (min-width: 24rem) {');
    assert.match(longDate, /\.subtitleShortDate \{\s*display: none;/);
    assert.match(longDate, /\.subtitleLongDate \{\s*display: inline;/);
    assert.match(block(css, '@container (min-width: 30rem) {'), /\.subtitleCondition \{\s*display: inline;/);
  });

  it('uses no viewport breakpoints and lets whole fields wrap', () => {
    assert.doesNotMatch(subtitle, /\b(sm|md|lg|xl):/);
    assert.match(subtitle, /data-testid="dashboard-household-line"/);
    assert.match(subtitle, /className="flex min-w-0 flex-wrap /);
    for (const id of ['dashboard-date', 'dashboard-time', 'dashboard-weather-line']) {
      assert.match(subtitle, new RegExp(`className="whitespace-nowrap[^"]*" data-testid="${id}"`), id);
    }
    // Only the name may truncate, and never wider than the pane.
    assert.match(subtitle, /max-w-full truncate[^"]*" data-testid="dashboard-household-name"/);
  });
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

// WT-29: Android Chrome does not shrink the layout viewport for the on-screen keyboard, so
// `DialogContent` centres above the keyboard and leaves `--keyboard-inset` out of its height.
// A caller's own `max-h-[...]` replaces that cap (tailwind-merge), so it must leave the inset
// out too, or a tall dialog is pushed off the top of the screen while the keyboard is open.

const root = join(__dirname, '..', '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });

/** Every `max-h-[...]` class a `<DialogContent ...>` opening tag passes, with its file. */
function dialogHeightOverrides(): { file: string; cls: string }[] {
  const found: { file: string; cls: string }[] = [];
  for (const file of files(root)) {
    const source = readFileSync(file, 'utf8');
    // The opening tag runs to the first `>` that is not the end of an arrow (`=>`).
    for (const tag of source.matchAll(/<DialogContent\b(?:[^>]|(?<==)>)*>/g)) {
      for (const cls of tag[0].matchAll(/(?<![\w:-])max-h-\[[^\]\s"]+\]/g)) found.push({ file: relative(root, file), cls: cls[0] });
    }
  }
  return found;
}

describe('dialog height caps leave the on-screen keyboard out (WT-29)', () => {
  test('the shared cap in DialogContent subtracts --keyboard-inset', () => {
    const source = readFileSync(join(root, 'components', 'ui', 'dialog.tsx'), 'utf8');
    assert.match(source, /max-h-\[calc\(var\(--dialog-max-h\)_-_var\(--keyboard-inset,0px\)\)\]/);
    assert.match(source, /top-\[calc\(50%_-_var\(--keyboard-inset,0px\)\/2\)\]/);
  });

  test('every caller override of the cap subtracts --keyboard-inset too', () => {
    const overrides = dialogHeightOverrides();
    assert.ok(overrides.length > 0, 'expected the known dialog height overrides to be found');
    const unaware = overrides.filter(({ cls }) => !cls.includes('--keyboard-inset'));
    assert.deepEqual(unaware, [], 'dialog height overrides that ignore the keyboard inset');
  });
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

// The Barcode Library README describes the tablet camera (`deviceCamera`) as it is wired
// (AGENTS.md: document verified current behavior): active only when a screen passes it.

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
});

describe('Barcode Library README: the tablet camera', () => {
  test('says the device-record camera is used exactly when a screen passes it to the scanner', () => {
    const readme = readFileSync('docs/modules/barcode-library/README.md', 'utf8');
    const scanner = readFileSync('src/components/barcode-scanner.tsx', 'utf8');
    assert.match(scanner, /deviceCamera\?: 'front' \| 'rear'/, 'the scanner accepts a device camera');
    const wired = files('src').some((path) => /deviceCamera=\{/.test(readFileSync(path, 'utf8')));
    const saysUnwired = readme.includes('but no screen passes it yet');
    assert.equal(saysUnwired, !wired, wired ? 'a screen passes deviceCamera: the README must describe it as used' : 'no screen passes deviceCamera: the README must say so');
  });
});

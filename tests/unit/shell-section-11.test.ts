import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('SL-1: section error boundaries', () => {
  it('Maintenance has its own route boundary with the shared crash recovery', () => {
    const boundary = source('src/app/maintenance/error.tsx');
    assert.match(boundary, /^'use client';/);
    assert.match(boundary, /useCrashRecovery\(error\)/);
    assert.match(boundary, /retry\(\)/);
    assert.match(boundary, /Maintenance ran into a problem/);
    assert.match(boundary, /role="alert"/);
    // Never claims an unsaved form was kept.
    assert.match(boundary, /may need to be entered again/);
  });
});


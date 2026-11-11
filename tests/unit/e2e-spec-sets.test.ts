import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { E2E_SPEC_DIR, SMOKE_SPECS, partitionSpecs, specSets } from '../../scripts/e2e/spec-sets.mjs';

describe('e2e spec sets (scripts/e2e/spec-sets.mjs)', () => {
  it('puts every non-local, non-visual spec of tests/e2e in exactly one set', () => {
    const onDisk = readdirSync(E2E_SPEC_DIR).filter((name) => name.endsWith('.spec.ts'));
    const { smoke, extended, excluded } = specSets();
    const runnable = onDisk.filter((name) => !name.endsWith('.local.spec.ts') && name !== 'visual.spec.ts');

    for (const name of runnable) {
      const path = `${E2E_SPEC_DIR}/${name}`;
      const count = Number(smoke.includes(path)) + Number(extended.includes(path));
      assert.equal(count, 1, `${path} is in ${count} sets`);
    }
    assert.equal(smoke.length + extended.length, runnable.length);
    assert.equal(new Set([...smoke, ...extended]).size, runnable.length);
    for (const path of excluded) {
      assert.ok(!smoke.includes(path) && !extended.includes(path), `${path} must not run in CI`);
    }
  });

  it('keeps local and visual specs out of both sets', () => {
    const { smoke, extended, excluded } = partitionSpecs(
      ['a.spec.ts', 'b.spec.ts', 'scan.local.spec.ts', 'visual.spec.ts', 'helpers.ts', 'auth.setup.ts'],
      ['a.spec.ts'],
    );
    assert.deepEqual(smoke, ['a.spec.ts']);
    assert.deepEqual(extended, ['b.spec.ts']);
    assert.deepEqual(excluded, ['scan.local.spec.ts', 'visual.spec.ts']);
  });

  it('picks up a new spec in the extended set without registering it', () => {
    const { extended } = partitionSpecs([...SMOKE_SPECS, 'brand-new.spec.ts']);
    assert.deepEqual(extended, ['brand-new.spec.ts']);
  });

  it('keeps the smoke list in its own order', () => {
    const { smoke } = partitionSpecs(['z.spec.ts', 'a.spec.ts'], ['z.spec.ts', 'a.spec.ts']);
    assert.deepEqual(smoke, ['z.spec.ts', 'a.spec.ts']);
  });

  it('fails loudly when a smoke entry does not exist on disk', () => {
    assert.throws(
      () => partitionSpecs(['renamed.spec.ts'], ['old-name.spec.ts']),
      /old-name\.spec\.ts, which does not exist/,
    );
  });

  it('rejects duplicate, local or visual smoke entries', () => {
    assert.throws(() => partitionSpecs(['a.spec.ts'], ['a.spec.ts', 'a.spec.ts']), /twice/);
    assert.throws(() => partitionSpecs(['x.local.spec.ts'], ['x.local.spec.ts']), /local-only or visual/);
    assert.throws(() => partitionSpecs(['visual.spec.ts'], ['visual.spec.ts']), /local-only or visual/);
  });

  it('has a smoke list whose every entry exists today', () => {
    assert.doesNotThrow(() => specSets());
  });
});

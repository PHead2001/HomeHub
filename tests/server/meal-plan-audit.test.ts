import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';

// scripts/ops/audit-meal-plans.mjs against the Firestore emulator: counts only,
// and it never writes (P2, PE-22i: pets get meal slots only through the in-app confirmation).
// The classification itself is unit tested (tests/unit/pets-meal-slots.test.ts); the
// Pets modules are not imported here (this runner's react-server condition cannot load React).
const HOUSE = 'meal-plan-audit-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const PROJECT = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-homehub-e2e';

const PETS: Record<string, Record<string, unknown>> = {
  times: { name: 'Times', foodSchedule: '1 cup at 8am and 6pm' },
  parts: { name: 'Parts', foodSchedule: 'breakfast (morning) and dinner (evening)' },
  count: { name: 'Count', foodSchedule: '1.5 cups twice daily' },
  conflict: { name: 'Conflict', foodSchedule: 'morning and evening', feedingsPerDay: 3 },
  ambiguous: { name: 'Ambiguous', foodSchedule: 'twice daily, morning' },
  nondaily: { name: 'Nondaily', foodSchedule: 'every other day' },
  structured: { name: 'Structured', foodSchedule: 'whatever she wants', feedingsPerDay: 2 },
  confirmed: { name: 'Confirmed', foodSchedule: '', mealPlan: { slots: [{ id: 'b', name: 'Breakfast', time: '07:00', amount: 1, unit: 'Cups' }], effectiveFrom: '2026-11-14' } },
  malformed: { name: 'Malformed', foodSchedule: '', mealPlan: { slots: [{ id: 'b', name: '', time: '7' }], effectiveFrom: 'today' } },
};

function runAudit(args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/ops/audit-meal-plans.mjs', ...args], { encoding: 'utf8', env: process.env, timeout: 60_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function counts(out: string): Record<string, number> {
  const parsed: Record<string, number> = {};
  for (const match of out.matchAll(/^([a-z-]+): (\d+) \(needs:/gm)) parsed[match[1]] = Number(match[2]);
  const pets = out.match(/^Pets scanned: (\d+)$/m);
  if (pets) parsed.pets = Number(pets[1]);
  return parsed;
}

describe('meal plan audit (read only)', () => {
  let baseline: Record<string, number> = {};

  before(async () => {
    await adminDb.recursiveDelete(house());
    baseline = counts(runAudit(['--project', PROJECT]).out);
    await house().set({ name: 'Audit', ownerUid: 'o1', timeZone: 'America/Chicago' });
    for (const [id, data] of Object.entries(PETS)) await house().collection('pets').doc(id).set({ type: 'Dog', ...data });
  });

  after(async () => {
    await adminDb.recursiveDelete(house());
  });

  test('prints counts only and writes nothing', async () => {
    const before = await house().collection('pets').get();
    const stamps = new Map(before.docs.map((doc) => [doc.id, doc.updateTime.toMillis()]));
    const { status, out } = runAudit(['--project', PROJECT]);
    assert.equal(status, 0, out);
    assert.match(out, /Mode: dry run \(read only, no writes\)/);
    const after = counts(out);
    const delta = (kind: string) => (after[kind] ?? 0) - (baseline[kind] ?? 0);
    assert.equal(delta('pets'), 9);
    for (const kind of ['suggest-times', 'suggest-parts', 'suggest-count', 'count-conflict', 'ambiguous', 'non-daily', 'structured-count', 'confirmed', 'malformed-plan']) {
      assert.equal(delta(kind), 1, kind);
    }
    // No names, ids or schedule text in the output.
    for (const [id, data] of Object.entries(PETS)) {
      assert.equal(out.includes(String(data.name)), false);
      assert.equal(out.includes(`/${id}`), false);
    }
    assert.equal(out.includes('twice daily'), false);
    const afterDocs = await house().collection('pets').get();
    for (const doc of afterDocs.docs) assert.equal(doc.updateTime.toMillis(), stamps.get(doc.id), `${doc.id} unchanged`);
    assert.equal(afterDocs.docs.some((doc) => doc.get('mealPlan') && doc.id !== 'confirmed' && doc.id !== 'malformed'), false);
  });

  test('refuses --apply', () => {
    const { status, out } = runAudit(['--project', PROJECT, '--apply']);
    assert.equal(status, 2);
    assert.match(out, /never writes/);
  });
});

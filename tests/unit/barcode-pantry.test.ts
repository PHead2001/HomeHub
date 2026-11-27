import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planRestock, planUsedUp, pantryProductFor } from '../../src/lib/barcode/pantry-by-barcode';
import { readPantryBatch } from '../../src/lib/shopping/pantry-batches';

const batch = (id: string, data: Record<string, unknown>) => readPantryBatch(id, {
  nameKey: String(data.name).toLowerCase(), location: 'Pantry', unit: 'items', packageSize: null, expiryDate: null, schemaVersion: 2, ...data,
});

describe('a scanned product in the pantry (BL-13, BL-16, BL-20, BL-21)', () => {
  const beans = batch('beans', { name: 'Beans', packages: 2, barcode: '0012345678905' });
  const beansSoon = batch('beans-2', { name: 'Beans', packages: 1, expiryDate: '2026-12-01', barcode: '0012345678905' });
  const rice = batch('rice', { name: 'Rice', packages: 1 });

  test('found by barcode in either form, then by name', () => {
    assert.equal(pantryProductFor([beans, rice], { barcode: '012345678905', name: 'Something else' })?.name, 'Beans');
    assert.equal(pantryProductFor([beans, rice], { barcode: '4006381333931', name: ' rice ' })?.name, 'Rice');
    assert.equal(pantryProductFor([beans, rice], { barcode: '4006381333931', name: 'Pasta' }), null);
  });

  test('used up removes ONE package from the soonest-expiring batch, never a measured amount', () => {
    const plan = planUsedUp([beans, beansSoon], { barcode: '0012345678905', name: 'Beans' });
    assert.equal(plan.kind, 'use');
    if (plan.kind !== 'use') return;
    assert.equal(plan.batch.id, 'beans-2');
    assert.equal(plan.remaining, 2);
    assert.equal(plan.askAddToList, false);
    const flour = batch('flour', { name: 'Flour', packages: 1, unit: 'g', packageSize: 1000, barcode: '4006381333931' });
    const last = planUsedUp([flour], { barcode: '4006381333931', name: 'Flour' });
    assert.equal(last.kind === 'use' && last.batch.id, 'flour');
    // At zero the screen asks "Add to list?" (D-8): nothing is added here.
    assert.equal(last.kind === 'use' && last.askAddToList, true);
    assert.equal(last.kind === 'use' && last.remaining, 0);
  });

  test('not stocked, or nothing left', () => {
    assert.deepEqual(planUsedUp([rice], { barcode: '4006381333931', name: 'Pasta' }), { kind: 'not-stocked' });
    const empty = batch('tea', { name: 'Tea', packages: 0, barcode: '96385074' });
    assert.deepEqual(planUsedUp([empty], { barcode: '96385074', name: 'Tea' }), { kind: 'not-stocked' });
  });

  test('restock adds one to the soonest batch, or a new one-item batch on the Pantry shelf', () => {
    const plan = planRestock([beans, beansSoon], { barcode: '0012345678905', name: 'Beans' });
    assert.equal(plan.kind === 'add-one' && plan.plan.kind === 'increment' && plan.plan.batch.id, 'beans-2');
    assert.deepEqual(planRestock([rice], { barcode: '4006381333931', name: 'Pasta' }), {
      kind: 'new',
      input: { name: 'Pasta', location: 'Pantry', unit: 'items', packages: 1, packageSize: null, expiryDate: null, barcode: '4006381333931' },
    });
  });
});

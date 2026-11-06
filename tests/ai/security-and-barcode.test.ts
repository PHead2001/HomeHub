import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveHouseholdAuthority } from '../../src/ai/household-authority';
import { HomeHubAiError } from '../../src/ai/errors';
import { parseOpenFoodFactsQuantity, parseSimplePackageQuantity } from '../../src/ai/barcode-quantity';

describe('membership-record household authorization', () => {
  test('without a membership record there is no authority, even for listed or owner emails', () => {
    // Legacy household fields are display data only; the server must match firestore.rules.
    assert.throws(() => resolveHouseholdAuthority({ uid: 'legacy-uid' }), HomeHubAiError);
    assert.throws(() => resolveHouseholdAuthority({ uid: 'owner-uid', member: undefined }), HomeHubAiError);
  });

  test('approved records resolve their role preset and overrides', () => {
    const owner = resolveHouseholdAuthority({ uid: 'owner-uid', member: { uid: 'owner-uid', role: 'owner', status: 'active' } });
    assert.equal(owner.role, 'owner');
    assert.equal(owner.permissions['household.delete'], true);
    const limited = resolveHouseholdAuthority({
      uid: 'member',
      member: { uid: 'member', role: 'member', status: 'active', permissions: { 'shopping.view': false } },
    });
    assert.equal(limited.permissions['shopping.view'], false);
    assert.equal(limited.permissions['household.delete'], false);
  });

  test('pending, unknown-role and mismatched records are denied', () => {
    for (const member of [
      { role: 'newuser', status: 'pending' },
      { role: 'member', status: 'pending' },
      { role: 'super-admin', status: 'active' },
      { uid: 'someone-else', role: 'owner', status: 'active' },
    ]) {
      assert.throws(() => resolveHouseholdAuthority({ uid: 'caller', member }), HomeHubAiError);
    }
  });
});

describe('Open Food Facts package quantity parsing', () => {
  test('maps supported simple package units', () => {
    assert.deepEqual(parseSimplePackageQuantity('128 fl oz'), { quantity: 128, unit: 'fl oz' });
    assert.deepEqual(parseSimplePackageQuantity('1 L'), { quantity: 1, unit: 'L' });
    assert.deepEqual(parseSimplePackageQuantity('500 ml'), { quantity: 500, unit: 'ml' });
    assert.deepEqual(parseSimplePackageQuantity('2 lbs'), { quantity: 2, unit: 'lbs' });
    assert.deepEqual(parseSimplePackageQuantity('6 eggs'), { quantity: 6, unit: 'items' });
  });

  test('uses normalized values for compound packages and rejects unsupported measurements', () => {
    assert.deepEqual(parseOpenFoodFactsQuantity({
      quantityText: '3 x 150 g',
      normalizedQuantity: 450,
      normalizedUnit: 'g',
    }), { quantity: 450, unit: 'g' });
    assert.equal(parseOpenFoodFactsQuantity({ quantityText: '1 bushel' }), null);
    assert.equal(parseOpenFoodFactsQuantity({ quantityText: 'per serving 30 g' }), null);
  });
});

describe('client permissions', () => {
  test('come only from an approved membership record', async () => {
    const { getMemberPermissions } = await import('../../src/lib/permissions');
    assert.equal(getMemberPermissions(null)['chores.view'], false);
    assert.equal(getMemberPermissions({ role: 'newuser', status: 'pending' })['chores.view'], false);
    assert.equal(getMemberPermissions({ role: 'member', status: 'pending' })['chores.view'], false);
    assert.equal(getMemberPermissions({ role: 'super-admin' as never, status: 'active' })['household.delete'], false);
    const guest = getMemberPermissions({ role: 'guest', status: 'active', permissions: { 'notifications.view': false } });
    assert.equal(guest['notifications.view'], false);
    assert.equal(guest['chores.view'], true);
    assert.equal(getMemberPermissions({ role: 'owner', status: 'active' })['household.delete'], true);
  });
});

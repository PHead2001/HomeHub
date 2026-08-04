import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveHouseholdAuthority } from '../../src/ai/household-authority';
import { HomeHubAiError } from '../../src/ai/errors';
import { parseOpenFoodFactsQuantity, parseSimplePackageQuantity } from '../../src/ai/barcode-quantity';

describe('conservative household authorization', () => {
  test('legacy non-owner profile elevation cannot become household authority', () => {
    const result = resolveHouseholdAuthority({
      uid: 'legacy-uid',
      email: 'legacy@example.test',
      household: {
        ownerUid: 'owner-uid',
        ownerEmail: 'owner@example.test',
        memberEmails: ['owner@example.test', 'legacy@example.test'],
      },
    });
    assert.equal(result.role, 'member');
    assert.equal(result.permissions['household.delete'], false);
    assert.equal(result.permissions['shopping.view'], true);
  });

  test('legacy owner requires owner evidence and nonmembers are rejected', () => {
    const owner = resolveHouseholdAuthority({
      uid: 'owner-uid',
      email: 'owner@example.test',
      household: { ownerUid: 'owner-uid', ownerEmail: 'owner@example.test', memberEmails: ['owner@example.test'] },
    });
    assert.equal(owner.role, 'owner');
    assert.throws(() => resolveHouseholdAuthority({
      uid: 'outsider',
      email: 'outsider@example.test',
      household: { memberEmails: [] },
    }), HomeHubAiError);
  });

  test('member document permissions override presets and pending members are denied', () => {
    const denied = resolveHouseholdAuthority({
      uid: 'member',
      email: 'member@example.test',
      household: { memberEmails: ['member@example.test'] },
      member: { role: 'member', status: 'active', permissions: { 'shopping.view': false } },
    });
    assert.equal(denied.permissions['shopping.view'], false);
    assert.throws(() => resolveHouseholdAuthority({
      uid: 'pending',
      email: 'pending@example.test',
      household: { memberEmails: ['pending@example.test'] },
      member: { role: 'newuser', status: 'pending' },
    }), HomeHubAiError);
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

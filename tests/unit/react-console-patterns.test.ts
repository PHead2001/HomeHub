import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { reactStructureErrors } from '../e2e/react-console-patterns';

describe('e2e React console guard patterns', () => {
  test('catches React key and hydration errors as the development build prints them', () => {
    const found = reactStructureErrors([
      'Warning: Encountered two children with the same key, `the-foxy-residence-e2e/weekly-groceries`. Keys should be unique so that components maintain their identity across updates.',
      'Warning: Each child in a list should have a unique "key" prop.%s%s See https://react.dev/link/warning-keys for more information.',
      'Error: Hydration failed because the initial UI does not match what was rendered on the server.',
      'Warning: Text content did not match. Server: "a" Client: "b"',
      'A tree hydrated but some attributes of the server rendered HTML didn\'t match the client properties.',
    ]);
    assert.equal(found.length, 5);
  });
  test('ignores unrelated noise', () => {
    assert.deepEqual(reactStructureErrors([
      'Scanner Error: NotFoundError: Requested device not found',
      'Failed to load resource: the server responded with a status of 404 (Not Found)',
      '[Fast Refresh] rebuilding',
      'Warning: Function components cannot be given refs.',
    ]), []);
  });
});

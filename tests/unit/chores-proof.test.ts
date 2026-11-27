import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { isProofPathFor, needsPhotoProof, pendingProofs, proofPath, readProof } from '../../src/lib/chores/proof';
import { chorePoints } from '../../src/lib/chores/stats';

describe('photo proof for kids (CH-30)', () => {
  it('asks only kids, only for library chores that want a photo', () => {
    assert.equal(needsPhotoProof('child', { requiresPhoto: true }), true);
    assert.equal(needsPhotoProof('member', { requiresPhoto: true }), false);
    assert.equal(needsPhotoProof('child', { requiresPhoto: false }), false);
    assert.equal(needsPhotoProof('child', null), false);
  });

  it('accepts only a photo in this chore\'s folder, named for the uploader', () => {
    const path = proofPath('h1', 'dishes-general-2026-11-27', 'kid1', 'AbCdEf123456', 'jpg');
    assert.equal(path, 'households/h1/chore-proofs/dishes-general-2026-11-27/kid1-AbCdEf123456.jpg');
    assert.equal(isProofPathFor(path, 'h1', 'dishes-general-2026-11-27', 'kid1'), true);
    assert.equal(isProofPathFor(path, 'h2', 'dishes-general-2026-11-27', 'kid1'), false, 'another household');
    assert.equal(isProofPathFor(path, 'h1', 'laundry', 'kid1'), false, 'another chore');
    assert.equal(isProofPathFor(path, 'h1', 'dishes-general-2026-11-27', 'kid2'), false, 'someone else\'s photo');
    assert.equal(isProofPathFor('households/h1/chore-proofs/dishes/../x/kid1-AbCdEf123456.jpg', 'h1', 'dishes', 'kid1'), false);
    assert.equal(isProofPathFor('households/h1/chore-proofs/dishes/kid1-AbCdEf123456.exe', 'h1', 'dishes', 'kid1'), false);
    assert.equal(isProofPathFor(42, 'h1', 'dishes', 'kid1'), false);
  });

  it('reads a stored proof and lists the pending ones, oldest first', () => {
    assert.equal(readProof({ status: 'approved' }), null);
    assert.equal(readProof(null), null);
    const pending = (id: string, at: string) => ({ id, isCompleted: false, proof: { status: 'pending', submittedByUid: 'kid', submittedByName: 'Kid', submittedAt: at, photoPath: 'p' } });
    const list = pendingProofs([
      pending('b', '2026-11-27T12:00:00.000Z'),
      pending('a', '2026-11-27T09:00:00.000Z'),
      { id: 'c', isCompleted: false, proof: { status: 'rejected', submittedByUid: 'kid', submittedAt: '2026-11-27T08:00:00.000Z' } },
      { id: 'd', isCompleted: true, proof: { status: 'pending', submittedByUid: 'kid', submittedAt: '2026-11-27T08:00:00.000Z' } },
    ]);
    assert.deepEqual(list.map(chore => chore.id), ['a', 'b']);
  });

  it('earns nothing while pending: an open chore has no points', () => {
    assert.equal(chorePoints({ isCompleted: false, originalDueDate: '2026-11-27', dueDate: '' }), 0);
  });

  it('is enforced on the server completion and in the rules, and mirrored on the page', () => {
    const server = readFileSync(resolve(process.cwd(), 'src/lib/server/chore-completion.ts'), 'utf8');
    assert.match(server, /return \{ choreId, status: 'refused', refused: 'photo' \}/);
    const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert.match(rules, /choreClientCompletionNeedsNoPhoto\(householdId\) &&/);
    assert.match(rules, /'occurrenceKey', 'proof'\]/);
    const storage = readFileSync(resolve(process.cwd(), 'storage.rules'), 'utf8');
    assert.match(storage, /match \/households\/\{householdId\}\/chore-proofs\/\{choreId\}\/\{fileName\}/);
    const page = readFileSync(resolve(process.cwd(), 'src/components/chore-chart-client.tsx'), 'utf8');
    assert.match(page, /else if \(needsPhoto\(chore\)\) \{/);
  });
});

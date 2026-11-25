import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { choreAnswerMeaning, SENDABLE_CAPABILITIES, UNDO_CAPABILITY_OF } from '../../src/lib/devices/device-action-answers';
import { DEVICE_CAPABILITIES, UNDO_OF, UNDO_PROVEN, requiredLevel } from '../../src/lib/devices/action-policy';
import { queueAllowed } from '../../src/lib/devices/offline-queue';

// Chore actions on the tablet (docs/modules/devices/README.md, "Device actions"): which
// capabilities the tablet sends, how each answer reads, which offer Undo, and the level
// and queue decisions that follow from the proven Undo and the points-PIN setting.

describe('what the tablet sends', () => {
  it('sends the chore capabilities, every Pets capability (F4b-1, F4b-2) but pet create, photos and the separate slot confirmation, and the maintenance actions with a tablet action (M8b)', () => {
    const notSent = new Set(['pets.pet.create', 'pets.photo.upload', 'pets.slots.confirm']);
    const expected = [
      'chores.complete', 'chores.complete.undo', 'chores.take', 'chores.take.undo',
      ...DEVICE_CAPABILITIES.filter((capability) => capability.startsWith('pets.') && !notSent.has(capability)),
      'maintenance.complete', 'maintenance.complete.undo', 'maintenance.log', 'maintenance.log.undo', 'maintenance.snooze', 'maintenance.snooze.undo',
      'maintenance.editSchedules', 'maintenance.log.delete', 'maintenance.record.delete',
    ].sort();
    // Attachments are not on tablets: their delete is classified but never sent.
    assert.equal(SENDABLE_CAPABILITIES.has('maintenance.attachment.delete'), false);
    assert.deepEqual([...SENDABLE_CAPABILITIES].sort(), expected);
    for (const capability of notSent) assert.equal(SENDABLE_CAPABILITIES.has(capability as never), false, capability);
  });

  it('each action offers the Undo capability the server maps back to it', () => {
    for (const [action, undo] of Object.entries(UNDO_CAPABILITY_OF)) {
      assert.ok((UNDO_OF as Record<string, readonly string[]>)[undo!]?.includes(action), `${undo} reverses ${action}`);
    }
  });
});

describe('levels and the queue with the chore Undo proven', () => {
  it('complete and take are face-level, queueable; the points-PIN setting raises them to PIN', () => {
    for (const capability of ['chores.complete', 'chores.take'] as const) {
      assert.ok(UNDO_PROVEN.has(capability));
      assert.equal(requiredLevel(capability, { pointsPin: 'off', actorRole: 'child' }), 'face');
      assert.equal(requiredLevel(capability, { pointsPin: 'kids', actorRole: 'child' }), 'pin');
      assert.equal(requiredLevel(capability, { pointsPin: 'kids', actorRole: 'member' }), 'face');
      assert.equal(requiredLevel(capability, { pointsPin: 'everyone', actorRole: 'owner' }), 'pin');
      assert.equal(queueAllowed(capability, { pointsPin: 'off', actorRole: 'member' }), true);
      // A PIN-level action never waits in the queue.
      assert.equal(queueAllowed(capability, { pointsPin: 'everyone', actorRole: 'member' }), false);
    }
    // Pets feeding is proven (F4b-1): face, queueable, and never raised by the points PIN (D-P6).
    assert.equal(requiredLevel('pets.feed', { pointsPin: 'everyone', actorRole: 'member' }), 'face');
    assert.equal(queueAllowed('pets.feed', { pointsPin: 'everyone', actorRole: 'child' }), true);
    // Doses are proven (F4b-2): face and queueable; one given more than 12 hours ago is PIN, never queued.
    assert.equal(requiredLevel('pets.dose.give', { pointsPin: 'off', actorRole: 'member' }), 'face');
    assert.equal(queueAllowed('pets.dose.give', { pointsPin: 'off', actorRole: 'member' }), true);
    assert.equal(requiredLevel('pets.dose.give.old', { pointsPin: 'off', actorRole: 'member' }), 'pin');
    assert.equal(queueAllowed('pets.dose.give.old', { pointsPin: 'off', actorRole: 'member' }), false);
  });
});

describe('reading the answers', () => {
  it('a completion offers Undo; already done names who; early and missing are plain notices', () => {
    assert.deepEqual(choreAnswerMeaning('chores.complete', { outcome: { status: 'completed' } }, 'Dishes'), { undoable: true, message: 'Dishes: done.' });
    assert.deepEqual(choreAnswerMeaning('chores.complete', { outcome: { status: 'already', completion: { completedByName: 'Max' } } }, 'Dishes'),
      { undoable: false, notice: true, message: 'Already done by Max.' });
    assert.equal(choreAnswerMeaning('chores.complete', { outcome: { status: 'refused', refused: 'early' } }, 'Dishes').message, "That chore isn't due yet.");
    assert.equal(choreAnswerMeaning('chores.complete', { outcome: { status: 'refused', refused: 'missing' } }, 'Dishes').message, 'That chore is gone.');
  });

  it('a take offers Undo; a chore already yours does not (R3)', () => {
    assert.equal(choreAnswerMeaning('chores.take', { status: 'taken' }, 'Bins').undoable, true);
    assert.deepEqual(choreAnswerMeaning('chores.take', { status: 'already_yours' }, 'Bins'), { undoable: false, notice: true, message: "It's already yours." });
  });

  it('every Undo answer reads as undone', () => {
    for (const status of ['undone', 'untaken', 'already', 'not_applied']) {
      assert.deepEqual(choreAnswerMeaning('chores.complete.undo', { status }, 'Dishes'), { undoable: false, message: 'Undone.' });
    }
  });
});

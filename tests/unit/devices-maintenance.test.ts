import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { choreAnswerMeaning, queuedSendResult, SENDABLE_CAPABILITIES, UNDO_CAPABILITY_OF } from '../../src/lib/devices/device-action-answers';
import { DEVICE_ACTION_POLICY, requiredLevel } from '../../src/lib/devices/action-policy';
import { dropNotice, queueAllowed } from '../../src/lib/devices/offline-queue';
import { maintenanceRoomView } from '../../src/lib/devices/tablet-maintenance';

// Maintenance on the tablet (M8b; docs/modules/devices/README.md, "Device actions: maintenance"):
// what the tablet sends, how each answer reads, which offer Undo, what the queue keeps or
// drops, and the room the view starts in.

const ok = (data: unknown) => ({ ok: true as const, data });

describe('what the tablet sends for maintenance', () => {
  it('Done, Log service and Snooze offer their own Undo; the PIN actions have none', () => {
    assert.equal(UNDO_CAPABILITY_OF['maintenance.complete'], 'maintenance.complete.undo');
    assert.equal(UNDO_CAPABILITY_OF['maintenance.log'], 'maintenance.log.undo');
    assert.equal(UNDO_CAPABILITY_OF['maintenance.snooze'], 'maintenance.snooze.undo');
    for (const capability of ['maintenance.editSchedules', 'maintenance.log.delete', 'maintenance.record.delete'] as const) {
      assert.equal(UNDO_CAPABILITY_OF[capability], undefined, capability);
      assert.ok(SENDABLE_CAPABILITIES.has(capability), capability);
    }
    // Every sendable capability has a sender in the tablet's pipeline.
    const source = readFileSync('src/components/devices/use-device-actions.tsx', 'utf8');
    for (const capability of SENDABLE_CAPABILITIES) assert.ok(source.includes(`'${capability}': (base`), capability);
  });

  it('face actions queue for anyone with the points PIN on Everyone; PIN actions never queue', () => {
    for (const capability of ['maintenance.complete', 'maintenance.log', 'maintenance.snooze'] as const) {
      assert.equal(requiredLevel(capability, { pointsPin: 'everyone', actorRole: 'child' }), 'face', capability);
      assert.equal(queueAllowed(capability, { pointsPin: 'everyone', actorRole: 'member' }), true, capability);
    }
    for (const capability of ['maintenance.editSchedules', 'maintenance.log.delete', 'maintenance.record.delete'] as const) {
      assert.equal(DEVICE_ACTION_POLICY[capability].levelClass, 'pin', capability);
      assert.equal(queueAllowed(capability, { pointsPin: 'off', actorRole: 'owner' }), false, capability);
    }
  });
});

describe('answers', () => {
  it('applied answers offer Undo; no-op answers are plain notices that never say done', () => {
    assert.deepEqual(choreAnswerMeaning('maintenance.complete', { result: { status: 'completed' } }, 'Replace filter'), { undoable: true, message: 'Replace filter: done.' });
    assert.deepEqual(choreAnswerMeaning('maintenance.log', { result: { status: 'saved' } }, 'Checked filter'), { undoable: true, message: 'Checked filter: logged.' });
    assert.deepEqual(choreAnswerMeaning('maintenance.snooze', { result: { status: 'snoozed' } }, 'Replace filter'), { undoable: true, message: 'Replace filter: snoozed a week.' });
    const already = choreAnswerMeaning('maintenance.complete', { result: { status: 'already_done', byName: 'Sam' } }, 'x');
    assert.deepEqual(already, { undoable: false, notice: true, message: 'Already done by Sam.' });
    assert.equal(choreAnswerMeaning('maintenance.complete', { result: { status: 'already_done', byName: 'sam@example.test' } }, 'x').message.includes('@'), false);
    for (const status of ['changed', 'gone', 'refused']) {
      const meaning = choreAnswerMeaning('maintenance.complete', { result: { status, reason: 'mileage_required' } }, 'x');
      assert.equal(meaning.undoable, false, status);
      assert.equal(meaning.notice, true, status);
      assert.doesNotMatch(meaning.message, /: done\.$/, status);
    }
    assert.equal(choreAnswerMeaning('maintenance.editSchedules', { result: { status: 'saved' } }, 'Schedules for Furnace').message, 'Schedules for Furnace.');
    assert.equal(choreAnswerMeaning('maintenance.log.delete', { result: { status: 'deleted' } }, 'Delete log').undoable, false);
    assert.equal(choreAnswerMeaning('maintenance.editSchedules', { result: { status: 'too_many_schedules' } }, 'x').notice, true);
  });

  it('a queued Done or Snooze that changed nothing is dropped with a notice that says why', () => {
    assert.deepEqual(queuedSendResult('maintenance.complete', ok({ result: { status: 'completed' } })), { ok: true });
    assert.deepEqual(queuedSendResult('maintenance.snooze', ok({ result: { status: 'snoozed' } })), { ok: true });
    assert.deepEqual(queuedSendResult('maintenance.log', ok({ result: { status: 'saved' } })), { ok: true });
    const changed = queuedSendResult('maintenance.complete', ok({ result: { status: 'changed' } }));
    assert.equal(changed.ok, false);
    const notice = dropNotice([{ entry: { actorName: 'Max', capability: 'maintenance.complete' } as never, code: changed.ok ? 'failed' : changed.code, reason: changed.ok ? undefined : changed.reason }]);
    assert.equal(notice, "1 change from this tablet couldn't be saved: this changed since it was shown. The latest is shown now.");
    const done = queuedSendResult('maintenance.complete', ok({ result: { status: 'already_done', byName: 'Sam' } }));
    assert.deepEqual(done, { ok: false, code: 'conflict', reason: 'already done by Sam.' });
    for (const undo of ['maintenance.complete.undo', 'maintenance.log.undo', 'maintenance.snooze.undo'] as const) {
      for (const status of ['undone', 'already_undone', 'not_applied']) assert.deepEqual(queuedSendResult(undo, ok({ status })), { ok: true }, `${undo} ${status}`);
      assert.deepEqual(queuedSendResult(undo, ok({ status: 'has_attachments' })), { ok: false, code: 'changed_since' });
    }
  });

  it('an Undo that changed nothing (files on the log) is a refusal, never "Undone."', () => {
    const source = readFileSync('src/components/devices/use-device-actions.tsx', 'utf8');
    assert.match(source, /status === 'has_attachments' \? \{ ok: false, code: 'not_undoable' \}/);
    for (const undo of ['maintenance.complete.undo', 'maintenance.log.undo', 'maintenance.snooze.undo']) {
      const escaped = undo.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      assert.match(source, new RegExp(`'${escaped}': \\(base\\) => [a-zA-Z]+\\(base\\)\\.then\\(maintenanceUndoAnswer\\)`), undo);
    }
  });
});

describe('the room the view starts in (MA-26)', () => {
  it("the tablet's room by default, all rooms on request, and no filter without a room", () => {
    assert.deepEqual(maintenanceRoomView('Kitchen', null), { room: 'Kitchen', all: false });
    assert.deepEqual(maintenanceRoomView('Kitchen', { room: 'Kitchen', all: true }), { room: null, all: true });
    // The record's room changed since "All rooms" was chosen: the new room applies again.
    assert.deepEqual(maintenanceRoomView('Garage', { room: 'Kitchen', all: true }), { room: 'Garage', all: false });
    assert.deepEqual(maintenanceRoomView('  ', null), { room: null, all: true });
  });
});

describe('unsaved schedule edits on a tablet (PR #212 review)', () => {
  it('the schedule dialog registers its unsaved input, so idle return and reloads wait for it', () => {
    const source = readFileSync('src/components/devices/tablet-maintenance.tsx', 'utf8');
    const dialog = source.slice(source.indexOf('function TabletScheduleEditDialog'));
    assert.match(dialog.slice(0, 2000), /useUnsavedInput\(dirty\)/);
    assert.match(dialog.slice(0, 2000), /const dirty = name !== initial\.name/);
  });

  it('the log form counts its title and odometer reading as unsaved input too', () => {
    const source = readFileSync('src/components/devices/tablet-maintenance.tsx', 'utf8');
    const dialog = source.slice(source.indexOf('function TabletLogServiceDialog'));
    assert.match(dialog.slice(0, 2500), /useUnsavedInput\(title !== initial\.title \|\| mileage !== initial\.mileage/);
  });
});

describe('tablet entries stay inside the request budget, and timing schedules a checklist item (PR #212 review)', () => {
  it('the log form limits its text and checks it before asking who is here', () => {
    const source = readFileSync('src/components/devices/tablet-maintenance.tsx', 'utf8');
    assert.match(source, /export const TABLET_LOG_TEXT_MAX = 8000;/);
    assert.match(source, /maxLength=\{TABLET_LOG_TEXT_MAX\}/);
    const dialog = source.slice(source.indexOf('function TabletLogServiceDialog'));
    assert.ok(dialog.indexOf('title.length + notes.length + provider.length > TABLET_LOG_TEXT_MAX') > 0, 'checked in the log dialog');
    assert.ok(dialog.indexOf('title.length + notes.length + provider.length > TABLET_LOG_TEXT_MAX') < dialog.indexOf('form.submit('), 'checked before dispatch');
  });
  it('a repeat or a next due date turns a checklist item into a scheduled one; a rename does not', async () => {
    const { scheduleEditIntentOf } = await import('../../src/lib/devices/tablet-maintenance');
    const asset = { id: 'a1', name: 'Fridge', category: 'Appliance', status: 'active', householdId: 'h', createdAt: 'x', updatedAt: 'x', schedules: [{ id: 's1', mode: 'checklist', scheduleName: 'Clean coils' }] };
    const target = { targetType: 'home_asset', asset, scheduleIndex: 0, schedule: asset.schedules[0] } as never;
    const timed = scheduleEditIntentOf(target, { scheduleName: 'Clean coils', intervalValue: 6, frequencyType: 'months', nextDueDate: '2026-12-01' }) as { values: Array<Record<string, unknown>> };
    assert.equal(timed.values[0].mode, 'scheduled');
    const renamed = scheduleEditIntentOf(target, { scheduleName: 'Clean the coils', intervalValue: null, frequencyType: 'months', nextDueDate: null }) as { values: Array<Record<string, unknown>> };
    assert.equal(renamed.values[0].mode, 'checklist');
  });
});

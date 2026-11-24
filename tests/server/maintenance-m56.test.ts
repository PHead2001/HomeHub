import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { personalOperationContext } from '../../src/lib/server/operation-context';
import {
  completeMaintenanceScheduleAs,
  saveHomeAssetAs,
  saveVehicleAs,
  undoVehicleMileageAs,
  updateVehicleMileageAs,
  MaintenanceOperationError,
} from '../../src/lib/server/maintenance-operations';
import { deleteMaintenanceRecordCascade } from '../../src/lib/server/maintenance-delete';
import { summarizeAndStoreLog } from '../../src/lib/server/maintenance-summary';
import { cleanupOrphanUploadsAs } from '../../src/lib/server/maintenance-files';
import {
  MAINTENANCE_DELETE_RESUME_AFTER_MS, resumeMaintenanceDeletions, type MaintenanceFileBucket,
} from '../../functions/src/shared/maintenance-delete';
import { notesHash } from '../../src/lib/maintenance/summary';
import { deleteMaintenanceRecord, updateVehicleMileage } from '../../src/app/maintenance/actions';

// M5/M6 against the Firestore and Auth emulators: anchors and lifetime through saves and completion
// (MA-11g end to end), Update mileage with Undo (MA-19), delete with files (MA-22, MA-4c) with an
// injected Storage double (partial failure, retry, upkeep resume), stored AI summaries (MA-11d)
// and the upload cleanup (MA-11k).
const HOUSE = 'maint-m56-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const assets = () => house().collection('home-assets');
const vehicles = () => house().collection('vehicles');
const logs = () => house().collection('maintenance');
const files = () => house().collection('maintenance-attachments');
const notes = () => house().collection('notifications');

// Noon on Tue Nov 24 2026 in Chicago.
const NOW = new Date('2026-11-24T18:00:00Z');
const ctx = (uid: string, now = NOW) => personalOperationContext({ uid, name: '' }, now);
const SAM = 'm56-sam';
const ALEX = 'm56-alex';

/** A Storage double: records deletions, can fail on chosen paths, lists by prefix. */
const bucketDouble = (objects: string[], failOn: Set<string> = new Set()) => {
  const present = new Set(objects);
  const deleted: string[] = [];
  const bucket: MaintenanceFileBucket & { deleted: string[]; present: Set<string> } = {
    deleted,
    present,
    async getFiles({ prefix }) {
      const listed = [...present].filter(name => name.startsWith(prefix)).map(name => ({
        name,
        delete: async () => { present.delete(name); deleted.push(name); },
      }));
      return [listed];
    },
    file(path: string) {
      return {
        async delete() {
          if (failOn.has(path)) throw new Error(`Storage unavailable for ${path}`);
          present.delete(path);
          deleted.push(path);
        },
      };
    },
  };
  return bucket;
};

const folder = (type: string, id: string) => `households/${HOUSE}/maintenance/${type}/${id}/`;

const seed = async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'M56', ownerUid: SAM, timeZone: 'America/Chicago', memberEmails: [] });
  await house().collection('members').doc(SAM).set({ uid: SAM, role: 'owner', status: 'active', displayName: 'Sam' });
  await house().collection('members').doc(ALEX).set({ uid: ALEX, role: 'member', status: 'active', displayName: 'Alex' });
  await vehicles().doc('car').set({ householdId: HOUSE, nickname: 'Car', status: 'active', currentMileage: 48000, mileageUpdatedAt: '2026-10-01', serviceSchedules: [], createdAt: 'x', updatedAt: 'x' });
};

beforeEach(seed);
after(async () => { await adminDb.recursiveDelete(house()); });

describe('anchors and lifetime warranties through saves and completion (MA-11g)', () => {
  test('a new asset keeps warrantyLifetime and a calendar schedule; completion keeps the calendar day', async () => {
    const saved = await saveHomeAssetAs(adminDb, HOUSE, {
      opId: randomUUID(),
      values: {
        name: 'House', category: 'Lawn / Outdoor', status: 'active', warrantyLifetime: true,
        schedules: [{ id: 'gutters', mode: 'scheduled', scheduleName: 'Clean gutters', frequencyType: 'years', intervalValue: 1, anchor: 'calendar', anchorMonth: 10, anchorDay: 1, nextDueDate: '2026-10-01' }],
      },
    }, ctx(SAM));
    const stored = (await assets().doc(saved.id).get()).data()!;
    assert.equal(stored.warrantyLifetime, true);
    assert.deepEqual({ anchor: stored.schedules[0].anchor, month: stored.schedules[0].anchorMonth, day: stored.schedules[0].anchorDay }, { anchor: 'calendar', month: 10, day: 1 });

    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, {
      opId: randomUUID(), ownerType: 'home_asset', ownerId: saved.id, scheduleId: 'gutters',
      seen: { nextDueDate: '2026-10-01', nextDueMileage: null }, completedDate: '2026-11-05',
    }, ctx(SAM));
    assert.ok(done.status === 'completed');
    assert.equal(done.next.nextDueDate, '2027-10-01');
    assert.equal((await assets().doc(saved.id).get()).data()!.schedules[0].nextDueDate, '2027-10-01');
  });

  test('a snoozed calendar schedule completes the cycle it was snoozed from (the snooze is read before it is removed)', async () => {
    await assets().doc('yard').set({
      householdId: HOUSE, name: 'Yard', category: 'Lawn / Outdoor', status: 'active',
      schedules: [{ id: 'gutters', mode: 'scheduled', scheduleName: 'Clean gutters', frequencyType: 'years', intervalValue: 1, anchor: 'calendar', anchorMonth: 10, anchorDay: 1, nextDueDate: '2026-11-30', snoozedUntil: '2026-11-30', snoozedFrom: '2026-11-23' }],
    });
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, {
      opId: randomUUID(), ownerType: 'home_asset', ownerId: 'yard', scheduleId: 'gutters',
      seen: { nextDueDate: '2026-11-30', nextDueMileage: null }, completedDate: '2026-11-24',
    }, ctx(SAM));
    assert.ok(done.status === 'completed');
    const schedule = (await assets().doc('yard').get()).data()!.schedules[0];
    assert.equal(schedule.snoozedUntil, undefined);
    assert.equal(schedule.snoozedFrom, undefined);
    assert.equal(schedule.anchor, 'calendar');
  });

  test('an edit changes only the anchor it touched; unchecking Lifetime removes it; bad anchors are refused', async () => {
    const base = { name: 'Box', category: 'Other', status: 'active', warrantyLifetime: true, schedules: [{ id: 's', scheduleName: 'Check', frequencyType: 'months', intervalValue: 3, anchor: 'calendar', anchorDay: 15 }] };
    const saved = await saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), values: base }, ctx(SAM));
    await saveHomeAssetAs(adminDb, HOUSE, {
      opId: randomUUID(), id: saved.id, base,
      values: { ...base, warrantyLifetime: false, schedules: [{ ...base.schedules[0], anchorDay: 20 }] },
    }, ctx(SAM));
    const stored = (await assets().doc(saved.id).get()).data()!;
    assert.equal(stored.warrantyLifetime, undefined);
    assert.equal(stored.schedules[0].anchorDay, 20);
    assert.equal(stored.schedules[0].anchor, 'calendar');
    for (const schedule of [{ anchor: 'sometimes' }, { anchorMonth: 13 }, { anchorDay: 0 }, { anchorDay: 1.5 }]) {
      await assert.rejects(saveHomeAssetAs(adminDb, HOUSE, {
        opId: randomUUID(), values: { name: 'Bad', category: 'Other', status: 'active', schedules: [{ id: 'b', scheduleName: 'B', ...schedule }] },
      }, ctx(SAM)), (error: unknown) => error instanceof MaintenanceOperationError && error.code === 'invalid');
    }
    await assert.rejects(saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), values: { name: 'Bad', category: 'Other', status: 'active', warrantyLifetime: 'yes' } }, ctx(SAM)));
  });

  test('a vehicle service keeps its calendar anchor through a save', async () => {
    const saved = await saveVehicleAs(adminDb, HOUSE, {
      opId: randomUUID(),
      values: { nickname: 'Van', status: 'active', serviceSchedules: [{ id: 'reg', serviceName: 'Tires', intervalMonths: 12, anchor: 'calendar', anchorMonth: 4, anchorDay: 15, nextDueDate: '2027-04-15' }] },
    }, ctx(SAM));
    const service = (await vehicles().doc(saved.id).get()).data()!.serviceSchedules[0];
    assert.deepEqual([service.anchor, service.anchorMonth, service.anchorDay], ['calendar', 4, 15]);
  });
});

describe('Update mileage (MA-19) and its Undo', () => {
  const update = (reading: unknown, extra: Record<string, unknown> = {}) => ({ opId: randomUUID(), vehicleId: 'car', reading, ...extra });
  const car = async () => (await vehicles().doc('car').get()).data()!;

  test('a higher reading is written with today; a replay writes nothing more', async () => {
    const input = update(48750);
    const first = await updateVehicleMileageAs(adminDb, HOUSE, input, ctx(SAM));
    assert.deepEqual({ ...first, opId: undefined, undoMs: undefined }, { status: 'updated', opId: undefined, currentMileage: 48750, mileageUpdatedAt: '2026-11-24', replay: false, undoMs: undefined });
    const again = await updateVehicleMileageAs(adminDb, HOUSE, input, ctx(SAM));
    assert.ok(again.status === 'updated' && again.replay);
    assert.equal((await car()).currentMileage, 48750);
    await assert.rejects(updateVehicleMileageAs(adminDb, HOUSE, input, ctx(ALEX)), (error: unknown) => error instanceof MaintenanceOperationError && error.code === 'conflict');
  });

  test('a result carries what is left of the Undo window; a late replay carries none', async () => {
    const input = update(49100);
    const fresh = await updateVehicleMileageAs(adminDb, HOUSE, input, ctx(SAM));
    assert.ok(fresh.status === 'updated');
    assert.ok(typeof fresh.undoMs === 'number' && fresh.undoMs > 8000 && fresh.undoMs <= 10_000, `fresh undoMs ${fresh.undoMs}`);
    const late = await updateVehicleMileageAs(adminDb, HOUSE, input, ctx(SAM, new Date(NOW.getTime() + 12_000)));
    assert.ok(late.status === 'updated' && late.replay);
    assert.equal(late.status === 'updated' ? late.undoMs : -1, 0);
  });

  test('a lower reading needs the explicit correction', async () => {
    assert.deepEqual(await updateVehicleMileageAs(adminDb, HOUSE, update(47000), ctx(SAM)), { status: 'refused', reason: 'lower_needs_correction' });
    assert.equal((await car()).currentMileage, 48000);
    const corrected = await updateVehicleMileageAs(adminDb, HOUSE, update(47000, { correction: true }), ctx(SAM));
    assert.ok(corrected.status === 'updated');
    assert.equal((await car()).currentMileage, 47000);
  });

  test('invalid input and a missing vehicle', async () => {
    assert.deepEqual(await updateVehicleMileageAs(adminDb, HOUSE, update(1.5), ctx(SAM)), { status: 'refused', reason: 'invalid_mileage' });
    await assert.rejects(updateVehicleMileageAs(adminDb, HOUSE, update('48000'), ctx(SAM)));
    assert.deepEqual(await updateVehicleMileageAs(adminDb, HOUSE, { ...update(100), vehicleId: 'gone' }, ctx(SAM)), { status: 'gone' });
  });

  test('Undo reverts within the window; a later higher reading stays; only the actor; expired after the window', async () => {
    const one = await updateVehicleMileageAs(adminDb, HOUSE, update(48750), ctx(SAM));
    assert.ok(one.status === 'updated');
    await assert.rejects(undoVehicleMileageAs(adminDb, HOUSE, { opId: one.opId }, ctx(ALEX)), (error: unknown) => error instanceof MaintenanceOperationError && error.code === 'forbidden');
    assert.deepEqual(await undoVehicleMileageAs(adminDb, HOUSE, { opId: one.opId }, ctx(SAM, new Date(NOW.getTime() + 5_000))), { status: 'undone', kept: [] });
    assert.deepEqual([(await car()).currentMileage, (await car()).mileageUpdatedAt], [48000, '2026-10-01']);
    assert.deepEqual(await undoVehicleMileageAs(adminDb, HOUSE, { opId: one.opId }, ctx(SAM)), { status: 'already_undone' });

    const two = await updateVehicleMileageAs(adminDb, HOUSE, update(49000), ctx(SAM));
    assert.ok(two.status === 'updated');
    await updateVehicleMileageAs(adminDb, HOUSE, update(49500), ctx(ALEX));
    const undo = await undoVehicleMileageAs(adminDb, HOUSE, { opId: two.opId }, ctx(SAM, new Date(NOW.getTime() + 3_000)));
    assert.deepEqual(undo, { status: 'undone', kept: [{ field: 'currentMileage', value: 49500 }] });
    assert.equal((await car()).currentMileage, 49500);

    const three = await updateVehicleMileageAs(adminDb, HOUSE, update(50000), ctx(SAM));
    assert.ok(three.status === 'updated');
    assert.deepEqual(await undoVehicleMileageAs(adminDb, HOUSE, { opId: three.opId }, ctx(SAM, new Date(NOW.getTime() + 60_000))), { status: 'expired' });
  });
});

describe('delete with files (MA-22, MA-4c)', () => {
  const seedAsset = async () => {
    await assets().doc('fridge').set({ householdId: HOUSE, name: 'Fridge', category: 'Appliance', status: 'active', schedules: [] });
    await assets().doc('fridge-10').set({ householdId: HOUSE, name: 'Other fridge', category: 'Appliance', status: 'active', schedules: [] });
    await logs().doc('coil-log').set({ householdId: HOUSE, targetType: 'home_asset', assetId: 'fridge', title: 'Cleaned coils', date: '2026-11-01' });
    await logs().doc('legacy-log').set({ householdId: HOUSE, assetId: 'fridge', title: 'Old', date: '2025-01-01' });
    const mine = folder('home_asset', 'fridge');
    await files().doc('f1').set({ householdId: HOUSE, targetType: 'home_asset', targetId: 'fridge', category: 'photo', fileName: 'a.jpg', filePath: `${mine}f1-a.jpg`, displayPath: `${mine}f1-display.jpg`, thumbnailPath: `${mine}f1-thumb.jpg`, uploadedByUid: SAM, createdAt: 'x' });
    await files().doc('f2').set({ householdId: HOUSE, targetType: 'home_asset', targetId: 'fridge', category: 'manual', fileName: 'm.pdf', filePath: `${mine}f2-m.pdf`, uploadedByUid: SAM, createdAt: 'x' });
    // History evidence and another record's file: never touched.
    await files().doc('log-receipt').set({ householdId: HOUSE, targetType: 'maintenance_log', targetId: 'coil-log', category: 'receipt', fileName: 'r.jpg', filePath: `${folder('maintenance_log', 'coil-log')}r.jpg`, uploadedByUid: SAM, createdAt: 'x' });
    await files().doc('other').set({ householdId: HOUSE, targetType: 'home_asset', targetId: 'fridge-10', category: 'photo', fileName: 'o.jpg', filePath: `${folder('home_asset', 'fridge-10')}o.jpg`, uploadedByUid: SAM, createdAt: 'x' });
    await notes().doc('fridge-warranty').set({ householdId: HOUSE, category: 'maintenance', sourceType: 'maintenance_asset_warranty', sourceId: 'fridge', stateKey: 'x', audience: ['*'] });
    await notes().doc('fridge10-warranty').set({ householdId: HOUSE, category: 'maintenance', sourceType: 'maintenance_asset_warranty', sourceId: 'fridge-10', stateKey: 'x', audience: ['*'] });
    return bucketDouble([
      `${mine}f1-a.jpg`, `${mine}f1-display.jpg`, `${mine}f1-thumb.jpg`, `${mine}f2-m.pdf`, `${mine}orphan-upload.jpg`,
      `${folder('maintenance_log', 'coil-log')}r.jpg`, `${folder('home_asset', 'fridge-10')}o.jpg`,
    ]);
  };
  const input = (extra = {}) => ({ householdId: HOUSE, targetType: 'home_asset' as const, targetId: 'fridge', actor: { uid: SAM, name: 'Sam' }, now: NOW, ...extra });

  test("one operation deletes the asset with its own files; logs stay as history with theirs; reminders resolve", async () => {
    const bucket = await seedAsset();
    const outcome = await deleteMaintenanceRecordCascade(adminDb, bucket, input());
    assert.deepEqual(outcome, { status: 'deleted', attachments: 2, files: 5, logs: 2, reminders: 1 });
    assert.equal((await assets().doc('fridge').get()).exists, false);
    assert.deepEqual((await files().get()).docs.map(doc => doc.id).sort(), ['log-receipt', 'other']);
    assert.deepEqual([...bucket.present].sort(), [`${folder('home_asset', 'fridge-10')}o.jpg`, `${folder('maintenance_log', 'coil-log')}r.jpg`]);
    const kept = (await logs().doc('coil-log').get()).data()!;
    assert.deepEqual([kept.targetType, kept.assetId, kept.formerTargetType, kept.formerTargetName], ['general', undefined, 'home_asset', 'Fridge']);
    assert.equal((await logs().doc('legacy-log').get()).data()!.formerTargetName, 'Fridge');
    assert.ok((await notes().doc('fridge-warranty').get()).data()!.resolvedAt);
    assert.equal((await notes().doc('fridge10-warranty').get()).data()!.resolvedAt, undefined);
    assert.equal((await house().collection('maintenance-deletions').get()).size, 0);
    // A retry is harmless.
    assert.equal((await deleteMaintenanceRecordCascade(adminDb, bucket, input())).status, 'already');
  });

  test('a Storage failure part-way leaves the database consistent; a retry finishes', async () => {
    const mine = folder('home_asset', 'fridge');
    const bucket = await seedAsset();
    const failing = bucketDouble([...bucket.present], new Set([`${mine}f2-m.pdf`]));
    await assert.rejects(deleteMaintenanceRecordCascade(adminDb, failing, input()));
    assert.equal((await assets().doc('fridge').get()).exists, false, 'gone from every list');
    // f1 is fully gone; f2's metadata stays while its object may still exist.
    assert.deepEqual((await files().where('targetId', '==', 'fridge').get()).docs.map(doc => doc.id), ['f2']);
    assert.ok(failing.present.has(`${mine}f2-m.pdf`));
    assert.equal((await house().collection('maintenance-deletions').doc('home_asset~fridge').get()).exists, true);
    // Retry with Storage back.
    const healthy = bucketDouble([...failing.present]);
    const retry = await deleteMaintenanceRecordCascade(adminDb, healthy, input());
    assert.equal(retry.status, 'deleted', 'the tombstone remembers it existed');
    assert.equal((await files().where('targetId', '==', 'fridge').get()).size, 0);
    assert.equal([...healthy.present].some(path => path.startsWith(mine)), false);
    assert.equal((await house().collection('maintenance-deletions').get()).size, 0);
  });

  test('the hourly upkeep resumes a stopped delete (after the grace period) and never deletes a record recreated meanwhile', async () => {
    const mine = folder('home_asset', 'fridge');
    const bucket = await seedAsset();
    await assert.rejects(deleteMaintenanceRecordCascade(adminDb, bucketDouble([...bucket.present], new Set([`${mine}f1-a.jpg`])), input()));
    const healthy = bucketDouble([...bucket.present]);
    const ts = (d: Date) => Timestamp.fromDate(d);
    const early = await resumeMaintenanceDeletions(adminDb, healthy, new Date(NOW.getTime() + 60_000), ts, FieldValue.delete());
    assert.equal(early.skipped >= 1, true);
    const later = new Date(NOW.getTime() + MAINTENANCE_DELETE_RESUME_AFTER_MS + 1_000);
    const sweep = await resumeMaintenanceDeletions(adminDb, healthy, later, ts, FieldValue.delete());
    assert.equal(sweep.resumed >= 1, true);
    assert.equal((await files().where('targetId', '==', 'fridge').get()).size, 0);
    assert.equal((await house().collection('maintenance-deletions').get()).size, 0);

    // A tombstone whose record exists again: the record stays, the stale tombstone goes.
    await assets().doc('fridge').set({ householdId: HOUSE, name: 'Fridge again', category: 'Appliance', status: 'active' });
    await house().collection('maintenance-deletions').doc('home_asset~fridge').set({ targetType: 'home_asset', targetId: 'fridge', name: 'Fridge', byUid: SAM, startedAt: NOW.toISOString() });
    await resumeMaintenanceDeletions(adminDb, healthy, later, ts, FieldValue.delete());
    assert.equal((await assets().doc('fridge').get()).exists, true);
    assert.equal((await house().collection('maintenance-deletions').get()).size, 0);
  });

  test('a log is deleted with its own files only', async () => {
    const bucket = await seedAsset();
    const outcome = await deleteMaintenanceRecordCascade(adminDb, bucket, input({ targetType: 'maintenance_log', targetId: 'coil-log' }));
    assert.deepEqual(outcome, { status: 'deleted', attachments: 1, files: 1, logs: 0, reminders: 0 });
    assert.equal((await logs().doc('coil-log').get()).exists, false);
    assert.equal((await files().doc('log-receipt').get()).exists, false);
    assert.equal((await files().doc('f1').get()).exists, true);
    assert.equal((await assets().doc('fridge').get()).exists, true);
  });

  test('a path outside the record folder is never deleted (forged metadata)', async () => {
    const bucket = await seedAsset();
    await files().doc('forged').set({ householdId: HOUSE, targetType: 'home_asset', targetId: 'fridge', category: 'other', fileName: 'x', filePath: `${folder('home_asset', 'fridge-10')}o.jpg`, uploadedByUid: SAM, createdAt: 'x' });
    await deleteMaintenanceRecordCascade(adminDb, bucket, input());
    assert.ok(bucket.present.has(`${folder('home_asset', 'fridge-10')}o.jpg`));
    assert.equal((await files().doc('forged').get()).exists, false, 'the forged metadata row of the deleted record goes');
  });

  test('without Storage, files are kept and the delete stays pending (nothing orphaned)', async () => {
    await seedAsset();
    await assert.rejects(deleteMaintenanceRecordCascade(adminDb, null, input()));
    assert.equal((await files().where('targetId', '==', 'fridge').get()).size, 2);
    assert.equal((await house().collection('maintenance-deletions').doc('home_asset~fridge').get()).exists, true);
  });
});

describe('stored AI summaries (MA-11d)', () => {
  const NOTES = 'Replaced the filter. Checked the coils and the fan.';
  const deps = (calls: string[], summary = 'Filter replaced; coils and fan checked.') => ({
    now: NOW,
    consumeQuota: async () => { calls.push('quota'); },
    generate: async (text: string) => { calls.push(`generate:${text}`); return { summary, model: 'deterministic/gpt-6-luna' }; },
  });

  test('stores the summary with the notes hash and model; a second request reuses it without AI or quota', async () => {
    await logs().doc('l1').set({ householdId: HOUSE, title: 'Service', date: '2026-11-01', notes: NOTES });
    const calls: string[] = [];
    const first = await summarizeAndStoreLog(adminDb, HOUSE, { logId: 'l1' }, deps(calls));
    assert.deepEqual({ stored: first.stored, reused: first.reused }, { stored: true, reused: false });
    const log = (await logs().doc('l1').get()).data()!;
    assert.equal(log.summary, 'Filter replaced; coils and fan checked.');
    assert.equal(log.summaryNotesHash, notesHash(NOTES));
    assert.equal(log.summaryModel, 'maintenance-summary@2/deterministic/gpt-6-luna');
    assert.equal(log.summaryAt, NOW.toISOString());
    const second = await summarizeAndStoreLog(adminDb, HOUSE, { logId: 'l1' }, deps(calls));
    assert.equal(second.reused, true);
    assert.deepEqual(calls, ['quota', `generate:${NOTES}`]);
    await summarizeAndStoreLog(adminDb, HOUSE, { logId: 'l1', regenerate: true }, deps(calls));
    assert.equal(calls.length, 4, 'regenerate on request');
  });

  test('changed notes regenerate; notes changed while the model runs are not overwritten by a stale summary', async () => {
    await logs().doc('l2').set({ householdId: HOUSE, title: 'Service', date: '2026-11-01', notes: NOTES, summary: 'Old', summaryNotesHash: notesHash('older notes') });
    const calls: string[] = [];
    const fresh = await summarizeAndStoreLog(adminDb, HOUSE, { logId: 'l2' }, deps(calls, 'New'));
    assert.ok(fresh.stored && !fresh.reused);
    const racing = await summarizeAndStoreLog(adminDb, HOUSE, { logId: 'l2', regenerate: true }, {
      ...deps(calls, 'Racing'),
      generate: async () => {
        await logs().doc('l2').update({ notes: 'Edited meanwhile.' });
        return { summary: 'Racing', model: 'm' };
      },
    });
    assert.equal(racing.stored, false);
    assert.equal((await logs().doc('l2').get()).data()!.summary, 'New');
  });

  test('a missing log, empty notes or a bad id is invalid_input; the summary is never client text', async () => {
    const calls: string[] = [];
    await logs().doc('empty').set({ householdId: HOUSE, title: 'x', date: '2026-11-01' });
    for (const input of [{ logId: 'nope' }, { logId: 'empty' }, { logId: 'a/b' }, { logId: 'l1', regenerate: 'yes' }]) {
      await assert.rejects(summarizeAndStoreLog(adminDb, HOUSE, input, deps(calls)), (error: unknown) => (error as { code?: string }).code === 'invalid_input');
    }
    assert.deepEqual(calls, []);
  });
});

describe('upload cleanup (MA-11k)', () => {
  const objectDouble = (owners: Record<string, string>) => {
    const deleted: string[] = [];
    return {
      deleted,
      file: (path: string) => ({
        getMetadata: async () => {
          if (!(path in owners)) throw new Error('No such object');
          return [{ metadata: { uploadedByUid: owners[path] } }] as [{ metadata: Record<string, unknown> }];
        },
        delete: async () => { deleted.push(path); },
      }),
    };
  };
  test("removes only the caller's own orphaned uploads in this household", async () => {
    const mine = `${folder('maintenance_log', 'l1')}1-r.jpg`;
    const theirs = `${folder('maintenance_log', 'l1')}2-r.jpg`;
    const linked = `${folder('maintenance_log', 'l1')}3-r.jpg`;
    await files().doc('linked').set({ householdId: HOUSE, targetType: 'maintenance_log', targetId: 'l1', category: 'receipt', fileName: 'r', filePath: linked, uploadedByUid: ALEX, createdAt: 'x' });
    const bucket = objectDouble({ [mine]: ALEX, [theirs]: SAM, [linked]: ALEX });
    const result = await cleanupOrphanUploadsAs(adminDb, bucket, HOUSE, [mine, theirs, linked], ALEX);
    assert.deepEqual(result, { removed: 1, refused: 2 });
    assert.deepEqual(bucket.deleted, [mine]);
    const outside = await cleanupOrphanUploadsAs(adminDb, bucket, HOUSE, ['households/other/maintenance/maintenance_log/l1/1-r.jpg', `${folder('maintenance_log', 'l1')}../x`], ALEX);
    assert.deepEqual(outside, { removed: 0, refused: 2 });
  });
});

describe('server actions: permissions', () => {
  const USERS = {
    logger: { uid: 'm56-logger', email: 'm56.logger@example.test' },
    deleter: { uid: 'm56-deleter', email: 'm56.deleter@example.test' },
  } as const;
  const tokens = new Map<string, string>();
  before(async () => {
    for (const { uid, email } of Object.values(USERS)) {
      await adminAuth.deleteUser(uid).catch(() => undefined);
      await adminAuth.createUser({ uid, email });
      const customToken = await adminAuth.createCustomToken(uid);
      const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      });
      tokens.set(uid, ((await response.json()) as { idToken: string }).idToken);
    }
  });
  const members = async () => {
    await house().collection('members').doc(USERS.logger.uid).set({
      uid: USERS.logger.uid, role: 'member', status: 'active', displayName: 'Lou', permissions: { 'maintenance.edit': false, 'maintenance.delete': false },
    });
    await house().collection('members').doc(USERS.deleter.uid).set({
      uid: USERS.deleter.uid, role: 'member', status: 'active', displayName: 'Dee', permissions: { 'maintenance.delete': true },
    });
  };

  test('delete needs maintenance.delete; Update mileage needs maintenance.edit', async () => {
    await members();
    await logs().doc('l9').set({ householdId: HOUSE, title: 'x', date: '2026-11-01' });
    const refused = await deleteMaintenanceRecord({ idToken: tokens.get(USERS.logger.uid)!, householdId: HOUSE, target: { targetType: 'maintenance_log', targetId: 'l9' } });
    assert.deepEqual(refused.ok ? null : refused.code, 'forbidden');
    assert.equal((await logs().doc('l9').get()).exists, true);
    const allowed = await deleteMaintenanceRecord({ idToken: tokens.get(USERS.deleter.uid)!, householdId: HOUSE, target: { targetType: 'maintenance_log', targetId: 'l9' } });
    assert.ok(allowed.ok && allowed.data.status === 'deleted');
    const bad = await deleteMaintenanceRecord({ idToken: tokens.get(USERS.deleter.uid)!, householdId: HOUSE, target: { targetType: 'pets' as 'vehicle', targetId: 'x' } });
    assert.equal(bad.ok ? null : bad.code, 'invalid');
    const mileage = await updateVehicleMileage({ idToken: tokens.get(USERS.logger.uid)!, householdId: HOUSE, mileage: { opId: randomUUID(), vehicleId: 'car', reading: 50000 } });
    assert.equal(mileage.ok ? null : mileage.code, 'forbidden');
  });
});

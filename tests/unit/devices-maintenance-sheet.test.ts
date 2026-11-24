import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { deleteConfirmation, latestLogsOf, ownFileCount } from '../../src/lib/devices/tablet-maintenance';
import type { MaintenanceLog } from '../../src/lib/types';

// The tablet's maintenance record sheet (M8b, Codex review of PR #212): the latest logs are the
// newest by date, and every permanent delete is confirmed first, naming the record and its files.

const log = (id: string, date: string | undefined, extra: Partial<MaintenanceLog> = {}) => ({ id, assetId: 'furnace', title: id, date, ...extra }) as MaintenanceLog;

describe('latest logs', () => {
  it('sorts by date (newest first, undated last) before taking five, whatever the document-id order', () => {
    // Document-id order puts the oldest first: a slice before sorting would miss the newest.
    const logs = [
      log('a-2020', '2020-01-01'), log('b-2021', '2021-01-01'), log('c-2022', '2022-01-01'), log('d-2023', '2023-01-01'),
      log('e-undated', undefined), log('f-2024', '2024-01-01'), log('g-2026', '2026-11-20'), log('h-other', '2026-11-21', { assetId: 'boiler' }),
    ];
    assert.deepEqual(latestLogsOf(logs, { targetType: 'home_asset', targetId: 'furnace' }).map((entry) => entry.id), ['g-2026', 'f-2024', 'd-2023', 'c-2022', 'b-2021']);
    assert.deepEqual(latestLogsOf([log('v', '2026-01-01', { assetId: undefined, vehicleId: 'car' })], { targetType: 'vehicle', targetId: 'car' }).map((entry) => entry.id), ['v']);
  });
});

describe('delete confirmation', () => {
  it('names the record and its files, and says it cannot be undone', () => {
    const logText = deleteConfirmation({ kind: 'log', name: 'Oil change', files: 2 });
    assert.equal(logText.title, 'Delete maintenance log "Oil change"?');
    assert.match(logText.description, /Its 2 attached files will be deleted too\. This cannot be undone\./);
    const asset = deleteConfirmation({ kind: 'home_asset', name: 'Furnace', files: 1 });
    assert.equal(asset.title, 'Delete home asset "Furnace"?');
    assert.match(asset.description, /Its logs stay as general maintenance records/);
    assert.match(asset.description, /Its 1 attached file will be deleted too/);
    assert.equal(deleteConfirmation({ kind: 'vehicle', name: 'Car', files: 0 }).description.includes('attached'), false);
    assert.equal(ownFileCount([{ targetType: 'maintenance_log', targetId: 'l1' }, { targetType: 'home_asset', targetId: 'l1' }, { targetType: 'maintenance_log', targetId: 'l2' }], 'maintenance_log', 'l1'), 1);
  });

  it('the sheet never dispatches a delete from the Delete buttons, only from the confirmation', () => {
    const source = readFileSync('src/components/devices/tablet-maintenance.tsx', 'utf8');
    // The only call that runs a delete request is the confirmation's action.
    const runs = source.match(/void run\(/g) ?? [];
    assert.equal(runs.length, 1);
    assert.match(source, /if \(chosen\) void run\(chosen\.key, chosen\.request, chosen\.after\)/);
    for (const capability of ['maintenance.log.delete', 'maintenance.record.delete']) {
      const at = source.indexOf(`capability: '${capability}'`);
      assert.ok(at > 0, capability);
      assert.match(source.slice(Math.max(0, at - 400), at), /setConfirming\(\{/, capability);
    }
    // The latest logs come from the shared order.
    assert.match(source, /const ownLogs = latestLogsOf\(logs, record\);/);
  });
});

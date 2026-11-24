import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAINTENANCE_FILE_MAX_BYTES, MAINTENANCE_FILE_TYPES, attachmentThumbnailUrl, checkMaintenanceFile, defaultAttachmentCategory,
  deleteActionLabel, derivedFilePaths, inferContentType,
} from '../../src/lib/maintenance/attachments';
import { pickTargetPhoto } from '../../src/lib/maintenance/display';
import {
  DETAIL_FIELDS, detailsToggleLabel, emptyDetailFields, formIsDirty, visibleDetailFields,
} from '../../src/lib/maintenance/form-sections';
import { mileageFreshness, parseMileageInput } from '../../src/lib/maintenance/mileage-freshness';
import {
  RECEIPT_TEXT_LIMITS, createReceiptReadGuard, receiptFieldsKept, receiptFillPatch, sanitizeReceiptFields,
} from '../../src/lib/maintenance/receipt-fill';
import { notesHash, storedSummaryOf } from '../../src/lib/maintenance/summary';
import {
  attachmentObjectPaths, logBelongsTo, maintenanceFileFolder, maintenanceTombstoneId, reminderBelongsTo,
} from '../../functions/src/shared/maintenance-delete';
import type { MaintenanceAttachment } from '../../src/lib/types';

// M5/M6: shorter forms, receipts, AI fill, stored summaries, mileage freshness and delete planning.

describe('file checks (MA-11c): the same limits as storage.rules', () => {
  test('the accepted types are exactly the rules regex', async () => {
    const { readFile } = await import('node:fs/promises');
    const rules = await readFile(new URL('../../storage.rules', import.meta.url), 'utf8');
    const pattern = /validMaintenanceFile\(\)[\s\S]*?matches\('([^']+)'\)/.exec(rules)?.[1];
    assert.ok(pattern, 'storage.rules has validMaintenanceFile');
    const regex = new RegExp(`^(?:${pattern.replace(/\[\.\]/g, '\\.')})$`);
    for (const type of MAINTENANCE_FILE_TYPES) assert.ok(regex.test(type), `${type} is accepted by the rules`);
    assert.ok(rules.includes('request.resource.size <= 15 * 1024 * 1024'));
    assert.equal(MAINTENANCE_FILE_MAX_BYTES, 15 * 1024 * 1024);
  });

  test('size limits and empty files', () => {
    assert.equal(checkMaintenanceFile({ name: 'r.jpg', type: 'image/jpeg', size: MAINTENANCE_FILE_MAX_BYTES }).ok, true);
    const big = checkMaintenanceFile({ name: 'big.jpg', type: 'image/jpeg', size: MAINTENANCE_FILE_MAX_BYTES + 1 });
    assert.ok(!big.ok && big.reason === 'too_large');
    const empty = checkMaintenanceFile({ name: 'e.pdf', type: 'application/pdf', size: 0 });
    assert.ok(!empty.ok && empty.reason === 'empty');
  });

  test('types: HEIC without a type, image/jpg, and refused types', () => {
    assert.equal(inferContentType({ name: 'IMG_0001.HEIC', type: '' }), 'image/heic');
    assert.equal(inferContentType({ name: 'IMG_0001.heic', type: 'image/heic-sequence' }), 'image/heic');
    assert.equal(inferContentType({ name: 'photo.jpg', type: 'image/jpg' }), 'image/jpeg');
    assert.equal(inferContentType({ name: 'scan.pdf', type: 'application/octet-stream' }), 'application/pdf');
    assert.equal(inferContentType({ name: 'logo.svg', type: 'image/svg+xml' }), null);
    assert.equal(inferContentType({ name: 'run.exe', type: 'application/x-msdownload' }), null);
    // A wrong extension never turns a refused type into an accepted one.
    assert.equal(inferContentType({ name: 'trick.pdf', type: 'text/html' }), null);
    const heic = checkMaintenanceFile({ name: 'IMG.HEIC', type: '', size: 2_000_000 });
    assert.ok(heic.ok && heic.heic && heic.image);
    const svg = checkMaintenanceFile({ name: 'x.svg', type: 'image/svg+xml', size: 10 });
    assert.ok(!svg.ok && svg.reason === 'type');
  });

  test('default categories (MA-11b): a log file is a receipt; documents are never a photo', () => {
    assert.equal(defaultAttachmentCategory('maintenance_log', 'image/jpeg'), 'receipt');
    assert.equal(defaultAttachmentCategory('maintenance_log', 'application/pdf'), 'receipt');
    assert.equal(defaultAttachmentCategory('home_asset', 'image/png'), 'photo');
    assert.equal(defaultAttachmentCategory('home_asset', 'application/pdf'), 'manual');
    assert.equal(defaultAttachmentCategory('vehicle', null), 'manual');
  });

  test('derived copies are siblings in the record folder; thumbnails never fall back to a HEIC file', () => {
    const folder = maintenanceFileFolder('h1', 'home_asset', 'a1');
    assert.deepEqual(derivedFilePaths(folder, '123-abc'), {
      displayPath: 'households/h1/maintenance/home_asset/a1/123-abc-display.jpg',
      thumbnailPath: 'households/h1/maintenance/home_asset/a1/123-abc-thumb.jpg',
    });
    assert.equal(attachmentThumbnailUrl({ downloadUrl: 'u', contentType: 'image/heic' }), null);
    assert.equal(attachmentThumbnailUrl({ downloadUrl: 'u', displayUrl: 'd', contentType: 'image/heic' }), 'd');
    assert.equal(attachmentThumbnailUrl({ downloadUrl: 'u', thumbnailUrl: 't', contentType: 'image/jpeg' }), 't');
  });
});

describe('card picture (MA-11b): a receipt never becomes the card picture', () => {
  const file = (id: string, category: MaintenanceAttachment['category'], createdAt: string, extra: Partial<MaintenanceAttachment> = {}): MaintenanceAttachment => ({
    id, householdId: 'h', targetType: 'home_asset', targetId: 'a1', category, fileName: `${id}.jpg`, filePath: 'p', downloadUrl: `https://x/${id}`,
    contentType: 'image/jpeg', createdAt, ...extra,
  });
  test('receipts and invoices are ignored even when they are the only images', () => {
    assert.equal(pickTargetPhoto([file('r', 'receipt', '2026-11-02'), file('i', 'invoice', '2026-11-03')], 'home_asset', 'a1'), null);
    assert.equal(pickTargetPhoto([file('r', 'receipt', '2026-11-02'), file('m', 'manual', '2026-11-01')], 'home_asset', 'a1')?.id, 'm');
    assert.equal(pickTargetPhoto([file('p', 'photo', '2026-11-01'), file('r', 'receipt', '2026-11-05')], 'home_asset', 'a1')?.id, 'p');
  });
  test('a HEIC photo counts only with its display copy', () => {
    const heic = file('h', 'photo', '2026-11-01', { contentType: 'image/heic', fileName: 'h.heic' });
    assert.equal(pickTargetPhoto([heic], 'home_asset', 'a1'), null);
    const shown = pickTargetPhoto([{ ...heic, displayUrl: 'https://x/h-display.jpg' }], 'home_asset', 'a1');
    assert.equal(shown?.id, 'h');
    // The card draws downloadUrl: it is the display copy.
    assert.equal(shown?.downloadUrl, 'https://x/h-display.jpg');
  });
});

describe('shorter forms (MA-15)', () => {
  test('a new record hides every detail behind "More details"', () => {
    const empty = { name: '', status: 'active', brand: '', notes: '' };
    assert.deepEqual(visibleDetailFields('asset', empty, false), []);
    assert.deepEqual(visibleDetailFields('asset', empty, true), DETAIL_FIELDS.asset);
    assert.equal(detailsToggleLabel(true, 8), 'More details');
  });
  test('an edit shows filled details and "Add details (N empty)" opens the empty ones', () => {
    const asset = { name: 'HVAC', status: 'needs_attention', brand: 'Trane', model: '', serialNumber: '', purchaseDate: '', purchasePrice: '1200', warrantyProvider: '', notes: '' };
    assert.deepEqual(visibleDetailFields('asset', asset, false), ['status', 'brand', 'purchasePrice']);
    const empty = emptyDetailFields('asset', asset);
    assert.deepEqual(empty, ['model', 'serialNumber', 'purchaseDate', 'warrantyProvider', 'notes']);
    assert.equal(detailsToggleLabel(false, empty.length), 'Add details (5 empty)');
  });
  test('a log keeps mileage only for vehicle logs; the default type counts as empty', () => {
    const log = { title: 'Oil', type: 'routine', serviceProvider: '', partsUsed: '', mileage: '48200', notes: '' };
    assert.deepEqual(visibleDetailFields('log', log, false, { vehicleLog: true }), ['mileage']);
    assert.deepEqual(visibleDetailFields('log', log, false), []);
    assert.equal(emptyDetailFields('log', log, { vehicleLog: false }).includes('mileage'), false);
  });
});

describe('unsaved-changes guard (MA-24f)', () => {
  test('dirty only when something really changed', () => {
    const initial = { form: { name: 'HVAC', notes: '', warrantyLifetime: false }, schedules: [{ id: 's1', scheduleName: 'Filter' }] };
    assert.equal(formIsDirty(initial, { form: { notes: undefined, name: 'HVAC ', warrantyLifetime: false }, schedules: [{ scheduleName: 'Filter', id: 's1' }] }), false);
    assert.equal(formIsDirty(initial, { ...initial, form: { ...initial.form, notes: 'x' } }), true);
    assert.equal(formIsDirty(initial, { ...initial, schedules: [] }), true);
    assert.equal(formIsDirty(initial, { ...initial, form: { ...initial.form, warrantyLifetime: true } }), true);
  });
});

describe('reading a receipt (MA-30)', () => {
  test('the answer is untrusted: numbers validated, text bounded and stripped of control characters', () => {
    const fields = sanitizeReceiptFields({
      cost: 129.954, serviceProvider: `  <b>Comfort Air</b>${String.fromCharCode(7)}${String.fromCharCode(0x202e)} `, partsUsed: 'x'.repeat(900), extra: 'drop me',
    });
    assert.equal(fields.cost, 129.95);
    assert.equal(fields.serviceProvider, '<b>Comfort Air</b>');
    assert.equal(fields.partsUsed?.length, RECEIPT_TEXT_LIMITS.partsUsed);
    assert.equal('extra' in fields, false);
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000, '12']) {
      assert.equal(sanitizeReceiptFields({ cost }).cost, undefined);
    }
    assert.deepEqual(sanitizeReceiptFields(null), {});
    assert.deepEqual(sanitizeReceiptFields(['x']), {});
  });

  test('a confirmed reading never overwrites a field the person edited, and only accepted fields fill', () => {
    const fields = { cost: 129.95, serviceProvider: 'Comfort Air', partsUsed: 'Filter' };
    assert.deepEqual(receiptFillPatch(fields, {}), { cost: '129.95', serviceProvider: 'Comfort Air', partsUsed: 'Filter' });
    assert.deepEqual(receiptFillPatch(fields, { cost: true }), { serviceProvider: 'Comfort Air', partsUsed: 'Filter' });
    assert.deepEqual(receiptFillPatch(fields, {}, { cost: true, serviceProvider: false, partsUsed: true }), { cost: '129.95', partsUsed: 'Filter' });
    assert.deepEqual(receiptFieldsKept(fields, { serviceProvider: true }), ['serviceProvider']);
  });

  test('a late answer is ignored after the receipt changed, was removed, or the form closed', () => {
    const guard = createReceiptReadGuard();
    const first = guard.start();
    assert.equal(guard.isCurrent(first), true);
    const second = guard.start(); // another receipt read
    assert.equal(guard.isCurrent(first), false);
    guard.cancel(); // receipt changed or cleared
    assert.equal(guard.isCurrent(second), false);
    const third = guard.start();
    guard.close(); // dialog closed
    assert.equal(guard.isCurrent(third), false);
    assert.equal(guard.isCurrent(guard.start()), false, 'nothing after close is current');
  });
});

describe('stored AI summaries (MA-11d)', () => {
  test('the notes hash ignores line endings and outer space, not content', () => {
    assert.equal(notesHash('Replaced filter.\r\nChecked coils. '), notesHash('Replaced filter.\nChecked coils.'));
    assert.notEqual(notesHash('Replaced filter.'), notesHash('Replaced filters.'));
    assert.match(notesHash(''), /^v1-0-[0-9a-f]{16}$/);
  });
  test('a stored summary is current only while the notes hash matches', () => {
    const notes = 'Replaced filter. Checked coils.';
    assert.deepEqual(storedSummaryOf({ notes, summary: 'S', summaryNotesHash: notesHash(notes) }), { state: 'current', summary: 'S' });
    assert.deepEqual(storedSummaryOf({ notes: `${notes} Also fan.`, summary: 'S', summaryNotesHash: notesHash(notes) }), { state: 'stale', summary: 'S' });
    assert.deepEqual(storedSummaryOf({ notes, summary: 'Legacy' }), { state: 'stale', summary: 'Legacy' });
    assert.deepEqual(storedSummaryOf({ notes }), { state: 'none' });
  });
});

describe('mileage freshness (MA-19)', () => {
  test('missing, unknown, fresh and stale', () => {
    assert.equal(mileageFreshness({}, '2026-11-24').state, 'missing');
    assert.equal(mileageFreshness({ currentMileage: 100 }, '2026-11-24').state, 'unknown');
    const fresh = mileageFreshness({ currentMileage: 100, mileageUpdatedAt: '2026-11-12' }, '2026-11-24');
    assert.ok(fresh.state === 'fresh' && fresh.days === 12);
    assert.equal(fresh.message, 'Mileage updated 12 days ago.');
    assert.equal(mileageFreshness({ currentMileage: 100, mileageUpdatedAt: '2026-10-25' }, '2026-11-24').state, 'fresh');
    const stale = mileageFreshness({ currentMileage: 100, mileageUpdatedAt: '2026-10-24' }, '2026-11-24');
    assert.ok(stale.state === 'stale' && stale.days === 31);
    assert.equal(mileageFreshness({ currentMileage: 100, mileageUpdatedAt: '2026-11-24' }, '2026-11-24').message, 'Mileage updated today.');
  });
  test('the numeric pad input', () => {
    assert.equal(parseMileageInput('48,750'), 48750);
    assert.equal(parseMileageInput(' 0 '), 0);
    for (const bad of ['', '-5', '1.5', 'abc', '2000001', '12345678']) assert.equal(parseMileageInput(bad), null);
  });
});

describe('delete planning (MA-22, MA-4c)', () => {
  const folder = maintenanceFileFolder('h1', 'home_asset', 'asset-1');
  test("only the record's own folder: never a longer id, another kind, or a nested path", () => {
    assert.equal(folder, 'households/h1/maintenance/home_asset/asset-1/');
    const paths = attachmentObjectPaths({
      filePath: `${folder}1-a.pdf`,
      displayPath: 'households/h1/maintenance/home_asset/asset-10/1-a-display.jpg',
      thumbnailPath: 'households/h1/maintenance/maintenance_log/asset-1/1-a-thumb.jpg',
    }, folder);
    assert.deepEqual(paths, [`${folder}1-a.pdf`]);
    assert.deepEqual(attachmentObjectPaths({ filePath: `${folder}x/../../other` }, folder), []);
    assert.deepEqual(attachmentObjectPaths({ filePath: folder }, folder), []);
    assert.deepEqual(attachmentObjectPaths({ filePath: 42 }, folder), []);
  });
  test('logs kept as history: linked by type and id (legacy by id); reminders by source id', () => {
    assert.equal(logBelongsTo({ targetType: 'home_asset', assetId: 'a1' }, 'home_asset', 'a1'), true);
    assert.equal(logBelongsTo({ assetId: 'a1' }, 'home_asset', 'a1'), true);
    assert.equal(logBelongsTo({ assetId: 'a1', vehicleId: 'v1' }, 'home_asset', 'a1'), false);
    assert.equal(logBelongsTo({ targetType: 'general', assetId: 'a1' }, 'home_asset', 'a1'), false);
    assert.equal(logBelongsTo({ targetType: 'home_asset', assetId: 'a10' }, 'home_asset', 'a1'), false);
    assert.equal(reminderBelongsTo({ sourceType: 'maintenance_asset_schedule', sourceId: 'a1:filter' }, 'home_asset', 'a1'), true);
    assert.equal(reminderBelongsTo({ sourceType: 'maintenance_asset_warranty', sourceId: 'a1' }, 'home_asset', 'a1'), true);
    assert.equal(reminderBelongsTo({ sourceType: 'maintenance_asset_schedule', sourceId: 'a10:filter' }, 'home_asset', 'a1'), false);
    assert.equal(reminderBelongsTo({ sourceType: 'maintenance_asset_schedule', sourceId: 'a1:filter', resolvedAt: 'x' }, 'home_asset', 'a1'), false);
    assert.equal(reminderBelongsTo({ sourceType: 'maintenance_vehicle_service', sourceId: 'a1:oil' }, 'home_asset', 'a1'), false);
    assert.equal(maintenanceTombstoneId('vehicle', 'car-1'), 'vehicle~car-1');
  });
  test('the confirmation names the files that go with the record', () => {
    assert.equal(deleteActionLabel('home_asset', 'Fridge', 3), 'Delete Fridge and its 3 attachments');
    assert.equal(deleteActionLabel('vehicle', 'Civic', 1), 'Delete Civic and its 1 attachment');
    assert.equal(deleteActionLabel('maintenance_log', '', 2), 'Delete log and its 2 files');
    assert.equal(deleteActionLabel('home_asset', 'Fridge', 0), 'Delete Home Asset');
    assert.equal(deleteActionLabel('maintenance_log', '', 0), 'Delete Log');
  });
});

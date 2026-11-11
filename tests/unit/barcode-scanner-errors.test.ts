import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SCANNER_ERROR_COPY, newScannerErrorSession, reportScannerError, scannerErrorKind, type ScannerErrorKind } from '../../src/lib/barcode/scanner-errors';

const named = (name: string) => Object.assign(new Error(name), { name });

describe('barcode scanner errors', () => {
  test('kinds from the camera error names', () => {
    assert.equal(scannerErrorKind(named('NotAllowedError')), 'permission');
    assert.equal(scannerErrorKind(named('SecurityError')), 'permission');
    assert.equal(scannerErrorKind(named('NotFoundError')), 'no-camera');
    assert.equal(scannerErrorKind(named('OverconstrainedError')), 'no-camera');
    assert.equal(scannerErrorKind(named('NotReadableError')), 'camera-busy');
    assert.equal(scannerErrorKind(named('NotSupportedError')), 'not-supported');
    assert.equal(scannerErrorKind(new Error('decode failed')), 'scan');
    assert.equal(scannerErrorKind('odd'), 'scan');
    assert.equal(scannerErrorKind(null), 'scan');
  });

  test('the same error repeated toasts only the first time', () => {
    let session = newScannerErrorSession();
    const toasts: boolean[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const report = reportScannerError(session, 'not-supported');
      toasts.push(report.toast);
      session = report.session;
    }
    assert.deepEqual(toasts, [true, false, false, false, false]);
  });

  test('a different kind toasts once more, and repeats of either do not', () => {
    let session = newScannerErrorSession();
    const sequence: ScannerErrorKind[] = ['camera-busy', 'camera-busy', 'permission', 'camera-busy', 'permission'];
    const toasts = sequence.map((kind) => {
      const report = reportScannerError(session, kind);
      session = report.session;
      return report.toast;
    });
    assert.deepEqual(toasts, [true, false, true, false, false]);
  });

  test('a new session (the scanner opened again) toasts again; sessions are not shared', () => {
    const first = reportScannerError(newScannerErrorSession(), 'scan').session;
    assert.equal(reportScannerError(first, 'scan').toast, false);
    assert.equal(reportScannerError(newScannerErrorSession(), 'scan').toast, true);
    // Reporting never changes the session it was given.
    const empty = newScannerErrorSession();
    reportScannerError(empty, 'scan');
    assert.equal(empty.toasted.size, 0);
  });

  test('every kind has a title and a description; the decode failure keeps its wording', () => {
    for (const copy of Object.values(SCANNER_ERROR_COPY)) {
      assert.ok(copy.title && copy.description);
    }
    assert.deepEqual(SCANNER_ERROR_COPY.scan, { title: 'Scan Error', description: 'Could not decode the barcode. Please try again.' });
    assert.equal(SCANNER_ERROR_COPY.permission.title, 'Camera Access Denied');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cameraConstraints,
  fallbackAfterCameraError,
  facingForDeviceCamera,
  nextCamera,
  paceScan,
  readCameraChoice,
  scannedBarcode,
  scannerStatus,
  serializeCameraChoice,
  SCAN_FORMATS,
} from '../../src/lib/barcode/scanner-camera';

describe('barcode scanner camera (BL-2, BL-7)', () => {
  test('only the facing is remembered (a device id can vanish); anything unreadable falls back to the rear camera', () => {
    const choice = { deviceId: 'cam-2', facing: 'user' as const };
    assert.equal(serializeCameraChoice(choice), '{"facing":"user"}');
    assert.deepEqual(readCameraChoice(serializeCameraChoice(choice)), { deviceId: null, facing: 'user' });
    assert.deepEqual(readCameraChoice('{"deviceId":"old","facing":"user"}'), { deviceId: null, facing: 'user' });
    assert.deepEqual(readCameraChoice(null), { deviceId: null, facing: 'environment' });
    assert.deepEqual(readCameraChoice('not json'), { deviceId: null, facing: 'environment' });
    assert.deepEqual(readCameraChoice('{"facing":"sideways","deviceId":7}'), { deviceId: null, facing: 'environment' });
    assert.deepEqual(readCameraChoice(null, 'user'), { deviceId: null, facing: 'user' });
  });

  test('a wall tablet record maps front to the user-facing camera', () => {
    assert.equal(facingForDeviceCamera('front'), 'user');
    assert.equal(facingForDeviceCamera('rear'), 'environment');
  });

  test('constraints prefer a facing (never exact) unless a device was chosen', () => {
    assert.deepEqual(cameraConstraints({ deviceId: null, facing: 'user' }), { video: { facingMode: 'user' }, audio: false });
    assert.deepEqual(cameraConstraints({ deviceId: 'abc', facing: 'user' }), { video: { deviceId: { exact: 'abc' } }, audio: false });
  });

  test('switching cycles through the cameras and needs at least two', () => {
    const current = { deviceId: null, facing: 'environment' as const };
    assert.equal(nextCamera([{ deviceId: 'a', label: 'Back camera' }], current, 'a'), null);
    const inputs = [{ deviceId: 'a', label: 'Back camera' }, { deviceId: 'b', label: 'Front camera' }];
    assert.deepEqual(nextCamera(inputs, current, 'a'), { deviceId: 'b', facing: 'user' });
    assert.deepEqual(nextCamera(inputs, { deviceId: 'b', facing: 'user' }, 'b'), { deviceId: 'a', facing: 'environment' });
    // Unlabelled cameras (before permission): the facing flips.
    assert.deepEqual(nextCamera([{ deviceId: 'x' }, { deviceId: 'y' }], current, 'x'), { deviceId: 'y', facing: 'user' });
  });

  test('a chosen camera that cannot open falls back to its facing', () => {
    assert.deepEqual(fallbackAfterCameraError({ deviceId: 'gone', facing: 'user' }, 'no-camera'), { deviceId: null, facing: 'user' });
    assert.deepEqual(fallbackAfterCameraError({ deviceId: 'busy', facing: 'environment' }, 'camera-busy'), { deviceId: null, facing: 'environment' });
    assert.equal(fallbackAfterCameraError({ deviceId: null, facing: 'user' }, 'no-camera'), null);
    assert.equal(fallbackAfterCameraError({ deviceId: 'x', facing: 'user' }, 'permission'), null);
  });

  test('only retail formats are decoded', () => {
    assert.deepEqual([...SCAN_FORMATS], ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128']);
  });

  test('a decoded text must be 6 to 32 digits (a QR URL is refused before any lookup)', () => {
    assert.equal(scannedBarcode('4006381333931'), '4006381333931');
    assert.equal(scannedBarcode(' 0123 4567 8905 '), '012345678905');
    assert.equal(scannedBarcode('https://example.com/x'), null);
    assert.equal(scannedBarcode('ABC123456'), null);
    assert.equal(scannedBarcode('12345'), null);
    assert.equal(scannedBarcode(42), null);
  });

  test('the same code within 3 s is a repeat; another code always counts', () => {
    let pace = paceScan(null, '111111', 1_000);
    assert.equal(pace.use, true);
    const repeat = paceScan(pace.pace, '111111', 2_500);
    assert.equal(repeat.use, false);
    // Held in view: each repeat starts the window again, so it never counts twice.
    assert.deepEqual(repeat.pace, { code: '111111', at: 2_500 });
    assert.equal(paceScan(repeat.pace, '111111', 5_000).use, false);
    assert.equal(paceScan(pace.pace, '222222', 1_100).use, true);
    pace = paceScan(repeat.pace, '111111', 5_600);
    assert.equal(pace.use, true);
  });

  test('status lines (BL-18)', () => {
    assert.equal(scannerStatus('ready'), 'Camera ready. Point it at a barcode.');
    assert.equal(scannerStatus({ scanned: '4006381333931' }), 'Scanned 4006381333931');
    assert.match(scannerStatus({ refused: true }), /not a product barcode/);
  });
});

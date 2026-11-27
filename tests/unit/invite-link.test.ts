import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import {
  JOIN_PATH,
  PENDING_JOIN_CODE_KEY,
  forgetJoinCode,
  inviteJoinUrl,
  joinCodeFromSearch,
  pendingJoinCode,
  rememberJoinCode,
  suggestedRoleFor,
} from '../../src/lib/invite-link';
import { QR_QUIET_ZONE, qrModules, qrSvgPath } from '../../src/lib/qr-code';
import { rank } from '../../src/lib/household-policy';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
};

/** Draws the modules as pixels (4 per module, white quiet zone) and decodes them with the scanner's reader. */
const decode = (text: string): string => {
  const { size, dark } = qrModules(text);
  const scale = 4;
  const width = (size + QR_QUIET_ZONE * 2) * scale;
  const pixels = new Int32Array(width * width).fill(0xffffff);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!dark[y * size + x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          pixels[((y + QR_QUIET_ZONE) * scale + dy) * width + (x + QR_QUIET_ZONE) * scale + dx] = 0;
        }
      }
    }
  }
  return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, width)))).getText();
};

describe('invite links (HO-16, HO-23)', () => {
  test('the link carries the normalized code on this origin', () => {
    assert.equal(inviteJoinUrl('https://homehub.example/', 'abcd efgh jk'), `https://homehub.example${JOIN_PATH}?code=ABCD-EFGH-JK`);
    assert.throws(() => inviteJoinUrl('https://homehub.example', 'nope'));
  });

  test('reading a link: loose codes are normalized, malformed or missing ones are ignored', () => {
    assert.equal(joinCodeFromSearch('?code=abcdefghjk'), 'ABCD-EFGH-JK');
    assert.equal(joinCodeFromSearch('code=ABCD-EFGH-JK&x=1'), 'ABCD-EFGH-JK');
    assert.equal(joinCodeFromSearch('?code=ABC'), null);
    assert.equal(joinCodeFromSearch('?code=<script>'), null);
    assert.equal(joinCodeFromSearch(''), null);
  });

  test('the waiting code lives in the tab only until the form uses it', () => {
    const storage = memoryStorage();
    rememberJoinCode(storage, null);
    assert.equal(storage.values.size, 0);
    rememberJoinCode(storage, 'ABCD-EFGH-JK');
    assert.equal(storage.values.get(PENDING_JOIN_CODE_KEY), 'ABCD-EFGH-JK');
    assert.equal(pendingJoinCode(storage), 'ABCD-EFGH-JK');
    storage.setItem(PENDING_JOIN_CODE_KEY, 'tampered!');
    assert.equal(pendingJoinCode(storage), '', 'a malformed stored value is never offered');
    forgetJoinCode(storage);
    assert.equal(pendingJoinCode(storage), '');
    assert.equal(pendingJoinCode(null), '');
  });

  test('a suggested role is assignable and below its creator', () => {
    assert.equal(suggestedRoleFor('child', rank('admin'), rank), 'child');
    assert.equal(suggestedRoleFor('admin', rank('owner'), rank), 'admin');
    assert.equal(suggestedRoleFor('admin', rank('admin'), rank), null, 'an admin cannot suggest admin');
    assert.equal(suggestedRoleFor('member', rank('member'), rank), null);
    assert.equal(suggestedRoleFor('owner', rank('owner'), rank), null);
    assert.equal(suggestedRoleFor('newuser', rank('owner'), rank), null);
    assert.equal(suggestedRoleFor(42, rank('owner'), rank), null);
  });
});

describe('QR codes', () => {
  test('an invite link survives the round trip through the scanner', () => {
    const url = inviteJoinUrl('https://homehub-prod.web.app', 'ABCD-EFGH-JK');
    assert.equal(decode(url), url);
  });

  test('the SVG path draws every dark module inside the quiet zone', () => {
    const modules = qrModules('https://example.test/join?code=ABCD-EFGH-JK');
    const path = qrSvgPath(modules);
    const darkCount = modules.dark.filter(Boolean).length;
    const drawn = [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)].reduce((sum, m) => {
      assert.ok(Number(m[1]) >= QR_QUIET_ZONE && Number(m[2]) >= QR_QUIET_ZONE);
      return sum + Number(m[3]);
    }, 0);
    assert.equal(drawn, darkCount);
    assert.equal(modules.dark.length, modules.size * modules.size);
  });
});

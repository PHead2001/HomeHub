import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  allowedTypos,
  brandMark,
  BRANDS,
  editDistance,
  matchBrand,
  normalizeBrand,
  type BrandEntry,
} from '../../src/lib/maintenance/brands';

const id = (input: string) => matchBrand(input)?.id ?? null;

describe('brand matching (H30)', () => {
  it("matches the owner's own brands", () => {
    for (const [input, expected] of [
      ['Subaru', 'subaru'],
      ['Ford', 'ford'],
      ['Mazda', 'mazda'],
      ['Whirlpool', 'whirlpool'],
      ['Frigidaire', 'frigidaire'],
      ['Ninja', 'ninja'],
    ]) {
      assert.equal(id(input), expected, input);
    }
  });

  it('tolerates the two known misspellings', () => {
    assert.equal(id('Whirpool'), 'whirlpool');
    assert.equal(id('Fridgidare'), 'frigidaire');
  });

  it('normalizes case, punctuation, accents, "&"/"and" and spaces', () => {
    assert.equal(normalizeBrand('A. O. Smith'), 'aosmith');
    assert.equal(normalizeBrand('Black & Decker'), normalizeBrand('black and decker'));
    assert.equal(normalizeBrand('Black+Decker'), 'blackdecker');
    assert.equal(normalizeBrand('Kärcher'), 'karcher');
    assert.equal(id('mercedes benz'), 'mercedes');
    assert.equal(id('MERCEDES-BENZ'), 'mercedes');
    assert.equal(id('A. O. Smith'), 'aosmith');
    assert.equal(id('Fisher and Paykel'), 'fisherpaykel');
    assert.equal(id('karcher'), 'karcher');
    assert.equal(id('  ford  '), 'ford');
    assert.equal(id('Café'), 'cafe');
    assert.equal(id("De'Longhi"), 'delonghi');
  });

  it('resolves aliases', () => {
    for (const [input, expected] of [
      ['Chevy', 'chevrolet'],
      ['VW', 'volkswagen'],
      ['Mercedes', 'mercedes'],
      ['Benz', 'mercedes'],
      ['GE Appliances', 'ge'],
      ['SharkNinja', 'ninja'],
      ['Roomba', 'irobot'],
      ['A O Smith', 'aosmith'],
      ['Kitchen Aid', 'kitchenaid'],
      ['Honda Power', 'honda'],
      ['Jenn-Air', 'jennair'],
    ]) {
      assert.equal(id(input), expected, input);
    }
  });

  it('drops company suffixes and trailing model words', () => {
    assert.equal(id('Ford Motor Company'), 'ford');
    assert.equal(id('Samsung Electronics America'), 'samsung');
    assert.equal(id('Whirlpool Gold Series'), 'whirlpool');
    assert.equal(id('GE Profile'), 'geprofile');
    assert.equal(id('Mitsubishi Electric'), 'mitsubishielectric');
    assert.equal(id('Mitsubishi'), 'mitsubishi');
  });

  it('matches short names only exactly', () => {
    assert.equal(id('GE'), 'ge');
    assert.equal(id('LG'), 'lg');
    assert.equal(id('Kia'), 'kia');
    assert.equal(id('Kai'), null);
    assert.equal(id('LJ'), null);
    assert.equal(id('Fird'), null);
    assert.equal(id('Toto'), 'toto');
    assert.equal(id('Toro'), 'toro');
  });

  it('allows one typo for 5–7 letters and two for 8 or more', () => {
    assert.equal(allowedTypos(4), 0);
    assert.equal(allowedTypos(5), 1);
    assert.equal(allowedTypos(7), 1);
    assert.equal(allowedTypos(8), 2);
    assert.equal(id('Subaur'), 'subaru'); // swapped neighbours count as one
    assert.equal(id('Mazdda'), 'mazda');
    assert.equal(id('Sbuaur'), null); // two typos in six letters
    assert.equal(id('Frigidiare'), 'frigidaire');
  });

  it('refuses ties between two different brands', () => {
    const catalog: BrandEntry[] = [
      { id: 'brandon', name: 'Brandon', category: 'tools' },
      { id: 'brandin', name: 'Brandin', category: 'tools' },
    ];
    assert.equal(matchBrand('Brandan', catalog), null);
    assert.equal(matchBrand('Brandon', catalog)?.id, 'brandon');
    assert.equal(matchBrand('Brandom', catalog)?.id, 'brandon');
  });

  it('never matches empty or placeholder values', () => {
    for (const input of ['', '   ', null, undefined, 'Generic', 'Unknown', 'N/A', 'none', 'Other']) {
      assert.equal(matchBrand(input), null, String(input));
    }
  });

  it('computes optimal-string-alignment distance', () => {
    assert.equal(editDistance('ford', 'ford'), 0);
    assert.equal(editDistance('ford', 'frod'), 1);
    assert.equal(editDistance('whirpool', 'whirlpool'), 1);
    assert.equal(editDistance('fridgidare', 'frigidaire'), 2);
    assert.ok(editDistance('subaru', 'toyota', 2) > 2);
  });

  it('has a unique id, a unique name and a short badge for every brand', () => {
    const ids = new Set(BRANDS.map((brand) => brand.id));
    assert.equal(ids.size, BRANDS.length);
    assert.ok(BRANDS.length >= 150, `only ${BRANDS.length} brands`);
    for (const brand of BRANDS) {
      assert.match(brand.id, /^[a-z0-9]+$/);
      const mark = brandMark(brand);
      assert.ok(mark.length >= 1 && mark.length <= 6, `${brand.name} badge "${mark}"`);
      assert.equal(matchBrand(brand.name)?.id, brand.id, `${brand.name} matches itself`);
    }
  });

  it('keys every bundled logo to a catalog brand', () => {
    const source = readFileSync(new URL('../../src/components/brand/brand-marks.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/^\s+'?([a-z0-9]+)'?: '/gm)].map((match) => match[1]);
    assert.ok(keys.length > 0);
    const ids = new Set(BRANDS.map((brand) => brand.id));
    for (const key of keys) assert.ok(ids.has(key), `logo ${key} has no brand`);
    assert.match(source, /CC0/);
  });
});

describe('vehicle photos (H30)', () => {
  it('picks the newest vehicle photo, never an asset photo with the same id', async () => {
    const { pickVehiclePhoto, pickAssetPhoto } = await import('../../src/lib/maintenance/display');
    const base = { householdId: 'h', fileName: 'a.png', filePath: 'p', downloadUrl: '/x.png', contentType: 'image/png', size: 1, uploadedByUid: 'u' };
    const attachments = [
      { ...base, id: 'old', targetType: 'vehicle' as const, targetId: 'car', category: 'photo' as const, createdAt: '2026-01-01' },
      { ...base, id: 'new', targetType: 'vehicle' as const, targetId: 'car', category: 'photo' as const, createdAt: '2026-06-01' },
      { ...base, id: 'asset', targetType: 'home_asset' as const, targetId: 'car', category: 'photo' as const, createdAt: '2026-07-01' },
      { ...base, id: 'manual', targetType: 'vehicle' as const, targetId: 'car', category: 'manual' as const, createdAt: '2026-08-01', fileName: 'm.pdf', contentType: 'application/pdf' },
    ];
    assert.equal(pickVehiclePhoto(attachments, 'car')?.id, 'new');
    assert.equal(pickAssetPhoto(attachments, 'car')?.id, 'asset');
    assert.equal(pickVehiclePhoto(attachments, 'other'), null);
  });
});

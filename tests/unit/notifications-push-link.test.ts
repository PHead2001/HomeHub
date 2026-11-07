import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { safePushLink } from '../../src/app/api/sw/push-link';
import { GET } from '../../src/app/api/sw/route';

describe('service worker push links', () => {
  test('in-app paths pass through unchanged', () => {
    for (const link of ['/', '/chores', '/chores?room=kitchen', '/shopping#list', '/pets/abc-123', '/notifications?tab=all']) {
      assert.equal(safePushLink(link), link);
    }
    assert.equal(safePushLink('  /chores  '), '/chores');
  });

  test('anything that could leave the origin falls back to the home page', () => {
    const hostile = [
      '//evil.com',
      '//evil.com/chores',
      '///evil.com',
      'https://evil.com',
      'http://evil.com/chores',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'evil.com',
      'chores',
      '/\\evil.com',
      '\\\\evil.com',
      '\\/evil.com',
      '/chores\\..\\..\\evil',
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r/evil.com',
      '/%2F/evil.com',
      '/%2f%2fevil.com',
      '/%5Cevil.com',
      '/%5c%5cevil.com',
      '/%09/evil.com',
      '/../evil',
      '/chores/../../admin',
      '/chores/%2e%2e/admin',
      '/chores/%2E%2E%2Fadmin',
      '/./chores',
      '/%E0%A4%A',
      '',
      '   ',
      `/${'a'.repeat(300)}`,
    ];
    for (const link of hostile) {
      assert.equal(safePushLink(link), '/', JSON.stringify(link));
    }
  });

  test('non-strings fall back to the home page', () => {
    for (const value of [undefined, null, 42, {}, ['/chores'], { toString: () => '/chores' }]) {
      assert.equal(safePushLink(value), '/');
    }
  });

  test('the worker embeds this exact check', async () => {
    const script = await (await GET()).text();
    const match = script.match(/const safePushLink = ([\s\S]*?);\n\s*const safePushAsset/);
    assert.ok(match, 'the worker defines safePushLink');
    const embedded = vm.runInNewContext(`(${match[1]})`, { URL }) as (link: unknown) => string;
    for (const link of ['/chores', '//evil.com', 'javascript:alert(1)', '/\t/evil.com', '/%2e%2e/x']) {
      assert.equal(embedded(link), safePushLink(link), JSON.stringify(link));
    }
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { safePushLink } from '../../src/app/api/sw/push-link';
import { GET } from '../../src/app/api/sw/route';
import { safeDeepLink } from '../../functions/src/push-policy';

const SAFE = ['/', '/chores', '/chores?room=kitchen', '/shopping#list', '/pets/abc-123', '/notifications?tab=all', '/household?tab=members'];

const HOSTILE: unknown[] = [
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
  '/chores\u0000',
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
  undefined,
  null,
  42,
  {},
  ['/chores'],
  { toString: () => '/chores' },
];

async function embeddedWorkerCheck() {
  const script = await (await GET()).text();
  const match = script.match(/const safePushLink = ([\s\S]*?);\n\s*const safePushAsset/);
  assert.ok(match, 'the worker defines safePushLink');
  return vm.runInNewContext(`(${match[1]})`, { URL }) as (link: unknown) => string;
}

// Every layer that opens a push link runs the same table, so they cannot drift:
// the Cloud Function (fcmOptions.link), the module the worker route imports, and
// the function source actually embedded in the served worker.
describe('push links at every layer', () => {
  const layers = async (): Promise<Array<[string, (link: unknown) => string]>> => [
    ['functions safeDeepLink', safeDeepLink],
    ['sw module safePushLink', safePushLink],
    ['served worker safePushLink', await embeddedWorkerCheck()],
  ];

  test('in-app paths pass through unchanged', async () => {
    for (const [name, check] of await layers()) {
      for (const link of SAFE) assert.equal(check(link), link, `${name} ${JSON.stringify(link)}`);
      assert.equal(check('  /chores  '), '/chores', name);
    }
  });

  test('anything that could leave the origin falls back to the home page', async () => {
    for (const [name, check] of await layers()) {
      for (const link of HOSTILE) {
        assert.equal(check(link), '/', `${name} ${typeof link === 'string' ? JSON.stringify(link) : String(link)}`);
      }
    }
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HomeAssistantError,
  fetchHomeAssistantStates,
  isPublicAddress,
  normalizeHomeAssistantUrl,
  pinnedFetch,
  publicOnlyLookup,
  toResponse,
  type Resolver,
} from '../../src/lib/server/home-assistant';

const publicResolver: Resolver = async () => ['93.184.216.34'];
const resolverFor = (addresses: string[]): Resolver => async () => addresses;

const rejectsWith = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof HomeAssistantError, String(error));
  assert.match(error.userMessage, pattern);
  return true;
});

describe('Home Assistant address safety', () => {
  test('only public addresses are allowed', () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.10', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1']) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) {
      assert.equal(isPublicAddress(address), true, address);
    }
  });

  test('IPv6 forms that embed a private IPv4 address are refused in any notation', async () => {
    for (const address of [
      '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '::ffff:127.0.0.1', // IPv4-mapped
      '::7f00:1', '::127.0.0.1', '::', // IPv4-compatible and unspecified
      '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', // NAT64
      '2002:7f00:1::', '2002:c0a8:101::1', // 6to4
      '2001:0:4136:e378::1', // Teredo
      'fe80::1%eth0', 'ff02::1',
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ['::ffff:5db8:d822', '64:ff9b::808:808', '2002:808:808::1']) {
      assert.equal(isPublicAddress(address), true, address);
    }
    // The URL parser canonicalizes the dotted tail to hex; both forms are refused.
    await rejectsWith(normalizeHomeAssistantUrl('https://[::ffff:127.0.0.1]', publicResolver), /private network/);
    await rejectsWith(normalizeHomeAssistantUrl('https://[::ffff:169.254.169.254]', publicResolver), /private network/);
  });

  test('http, local names, credentials in the URL and private DNS answers are refused', async () => {
    await rejectsWith(normalizeHomeAssistantUrl('http://example.com', publicResolver), /https/);
    await rejectsWith(normalizeHomeAssistantUrl('https://homeassistant.local:8123', publicResolver), /inside your home/);
    await rejectsWith(normalizeHomeAssistantUrl('https://user:pass@example.com', publicResolver), /username and password/);
    await rejectsWith(normalizeHomeAssistantUrl('https://169.254.169.254', publicResolver), /private network/);
    await rejectsWith(normalizeHomeAssistantUrl('https://rebind.example', resolverFor(['93.184.216.34', '10.0.0.1'])), /private network/);
    await rejectsWith(normalizeHomeAssistantUrl('not a url', publicResolver), /starting with https/);
  });

  test('a public https address is normalized without query, hash or trailing slash', async () => {
    assert.equal(await normalizeHomeAssistantUrl(' https://Home.Example.com:8443/?x=1#y ', publicResolver), 'https://home.example.com:8443');
  });
});

describe('Home Assistant state fetch', () => {
  const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('returns trimmed summaries and never forwards unexpected attributes', async () => {
    let requested = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requested = url;
      assert.equal(init.redirect, 'manual');
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer token-1234567890abcdefghij');
      return response(200, [
        { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen', secret_url: 'http://internal' } },
        { entity_id: 'sensor.temp', state: 21.5, attributes: { unit_of_measurement: '°C' } },
        { nonsense: true },
      ]);
    }) as unknown as typeof fetch;
    const entities = await fetchHomeAssistantStates('https://home.example.com', 'token-1234567890abcdefghij', { fetchImpl, resolve: publicResolver });
    assert.equal(requested, 'https://home.example.com/api/states');
    assert.deepEqual(entities, [
      { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen', unit_of_measurement: undefined, device_class: undefined } },
      { entity_id: 'sensor.temp', state: '21.5', attributes: { friendly_name: undefined, unit_of_measurement: '°C', device_class: undefined } },
    ]);
  });

  test('stored legacy URLs are re-validated before any request', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return response(200, []); }) as unknown as typeof fetch;
    await rejectsWith(fetchHomeAssistantStates('http://homeassistant.local:8123', 't'.repeat(30), { fetchImpl, resolve: publicResolver }), /https/);
    assert.equal(called, false);
  });

  test('redirects, rejected tokens and non-Home-Assistant answers get clear messages', async () => {
    const answer = (status: number, body: unknown) => (async () => response(status, body)) as unknown as typeof fetch;
    const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, resolve: publicResolver });
    await rejectsWith(fetchHomeAssistantStates('https://h.example.com', 't'.repeat(30), opts(answer(302, {}))), /redirected/);
    await rejectsWith(fetchHomeAssistantStates('https://h.example.com', 't'.repeat(30), opts(answer(401, {}))), /rejected the access token/);
    await rejectsWith(fetchHomeAssistantStates('https://h.example.com', 't'.repeat(30), opts(answer(200, { ok: true }))), /did not respond like Home Assistant/);
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await rejectsWith(fetchHomeAssistantStates('https://h.example.com', 't'.repeat(30), opts(failing)), /did not answer/);
  });
});

describe('connect-time address pinning (DNS rebinding, CodeQL js/request-forgery)', () => {
  const lookupOnce = (resolve: Resolver, all = false) => new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>((done) => {
    publicOnlyLookup(resolve)('ha.example.com', { all }, (error, address) => done({ error, address }));
  });

  test('the socket lookup refuses private, mixed and empty answers', async () => {
    for (const answer of [['10.0.0.1'], ['93.184.216.34', '169.254.169.254'], ['::1'], []]) {
      const { error } = await lookupOnce(resolverFor(answer));
      assert.equal(error?.code, 'EHOMEHUBPRIVATE', `expected refusal for ${JSON.stringify(answer)}`);
    }
  });

  test('the socket lookup passes public addresses through, single and all', async () => {
    const single = await lookupOnce(resolverFor(['93.184.216.34']));
    assert.equal(single.error, null);
    assert.equal(single.address, '93.184.216.34');
    const all = await lookupOnce(resolverFor(['93.184.216.34', '2606:4700::1111']), true);
    assert.equal(all.error, null);
    assert.deepEqual(all.address, [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }]);
  });

  test('a rebinding answer at connect time is refused before any request is sent', async () => {
    // First lookup (validation in normalizeHomeAssistantUrl) sees a public address;
    // the second (the socket's own lookup) is rebound to the metadata server.
    let calls = 0;
    const rebinding: Resolver = async () => (calls++ === 0 ? ['93.184.216.34'] : ['169.254.169.254']);
    await rejectsWith(fetchHomeAssistantStates('https://rebind.example.com', 't'.repeat(30), { resolve: rebinding }), /private network/);
    assert.equal(calls, 2, 'the socket resolved the host itself instead of trusting the first answer');
  });

  test('pinnedFetch only speaks https', async () => {
    await assert.rejects(pinnedFetch(publicResolver)('http://ha.example.com/api/states'), (error: unknown) => error instanceof HomeAssistantError);
  });
});

describe('pinned response building (hostile status codes)', () => {
  const body = [Buffer.from('ignored body')];

  test('null-body statuses never throw, even when the server sends a body (205 Reset Content)', async () => {
    for (const status of [204, 205, 304]) {
      const response = toResponse(status, body);
      assert.equal(response.status, status);
      assert.equal(await response.text(), '');
    }
  });

  test('ordinary statuses keep their body', async () => {
    const response = toResponse(200, [Buffer.from('[]')]);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    assert.equal(toResponse(undefined, []).status, 502);
  });

  test('statuses Response cannot represent throw, so the listener rejects instead of crashing', () => {
    for (const status of [600, 999, 0]) assert.throws(() => toResponse(status, body));
  });
});

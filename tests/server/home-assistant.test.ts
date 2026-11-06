import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HomeAssistantError,
  fetchHomeAssistantStates,
  isPublicAddress,
  normalizeHomeAssistantUrl,
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

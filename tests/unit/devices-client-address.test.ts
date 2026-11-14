import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientAddress, isIpAddress, trustedProxyHopsFromEnv } from '../../src/lib/devices/client-address';

// The client address used to rate-limit device-code redemption: never the first
// X-Forwarded-For hop (the client can set it), but the entry the platform's front end
// appended, `trustedProxyHops` from the right (docs/modules/devices/README.md, 3.4).

const headers = (value: string | null) => ({ get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? value : null) });

describe('clientAddress', () => {
  it('takes the next-to-last entry by default (App Hosting / Cloud Run)', () => {
    assert.equal(clientAddress(headers('203.0.113.7, 10.0.0.1')), '203.0.113.7');
  });

  it('ignores whatever the client put at the front of the chain', () => {
    assert.equal(clientAddress(headers('1.1.1.1, 2.2.2.2, 203.0.113.7, 10.0.0.1')), '203.0.113.7');
    assert.equal(clientAddress(headers('9.9.9.9, 203.0.113.7, 10.0.0.1')), '203.0.113.7');
  });

  it('honours the configured hop count', () => {
    assert.equal(clientAddress(headers('203.0.113.7'), 0), '203.0.113.7');
    assert.equal(clientAddress(headers('1.1.1.1, 203.0.113.7, 10.0.0.1, 10.0.0.2'), 2), '203.0.113.7');
  });

  it('IPv6 addresses work and are lower-cased', () => {
    assert.equal(clientAddress(headers('2001:DB8::1, 10.0.0.1')), '2001:db8::1');
    assert.equal(clientAddress(headers('::ffff:203.0.113.7, 10.0.0.1')), '::ffff:203.0.113.7');
  });

  it('absent, too short or malformed chains give no address (the per-instance limit still applies)', () => {
    assert.equal(clientAddress(headers(null)), null);
    assert.equal(clientAddress(headers('')), null);
    assert.equal(clientAddress(headers('10.0.0.1')), null);
    assert.equal(clientAddress(headers('203.0.113.7, , 10.0.0.1')), null);
    assert.equal(clientAddress(headers('evil, 10.0.0.1')), null);
    assert.equal(clientAddress(headers('203.0.113.7:4444, 10.0.0.1')), null);
    assert.equal(clientAddress(headers('[2001:db8::1], 10.0.0.1')), null);
    assert.equal(clientAddress(headers('256.1.1.1, 10.0.0.1')), null);
  });

  it('a spoofed entry cannot shift the trusted position', () => {
    // An attacker appending fake hops in their own header only adds entries to the left.
    const spoofed = clientAddress(headers('203.0.113.99, 198.51.100.1, 10.0.0.1'));
    assert.equal(spoofed, '198.51.100.1');
  });
});

describe('isIpAddress and the hop setting', () => {
  it('recognizes bare IPv4 and IPv6 only', () => {
    for (const ok of ['1.2.3.4', '255.255.255.255', '::1', 'fe80::1', '2001:db8:0:0:0:0:0:1']) assert.equal(isIpAddress(ok), true, ok);
    for (const bad of ['1.2.3', '1.2.3.4.5', '01.2.3.4x', 'localhost', '1.2.3.4:80', ':::::::::', 'gggg::1']) assert.equal(isIpAddress(bad), false, bad);
  });

  it('reads HOMEHUB_TRUSTED_PROXY_HOPS within 0..5, else 1', () => {
    assert.equal(trustedProxyHopsFromEnv(undefined), 1);
    assert.equal(trustedProxyHopsFromEnv(''), 1);
    assert.equal(trustedProxyHopsFromEnv('2'), 2);
    assert.equal(trustedProxyHopsFromEnv('0'), 0);
    assert.equal(trustedProxyHopsFromEnv('9'), 1);
    assert.equal(trustedProxyHopsFromEnv('one'), 1);
  });
});

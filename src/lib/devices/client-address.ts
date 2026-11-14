// The client address used to rate-limit unauthenticated device-code redemption.
//
// The first X-Forwarded-For entry is whatever the client sent, so it is never trusted.
// Each proxy appends the address it received the request from; the entry appended by
// the platform's front end is therefore the rightmost one not added by HomeHub's own
// proxies. `trustedProxyHops` is how many entries those proxies append after it (on
// Firebase App Hosting / Cloud Run the client is the next-to-last entry: 1 hop). The
// hop count is configurable (HOMEHUB_TRUSTED_PROXY_HOPS) because it must be confirmed
// against the deployed platform. See docs/modules/devices/README.md.

export type HeaderSource = { get(name: string): string | null };

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;
const IPV6_V4_TAIL = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,6}:(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/i;

/** True for a bare IPv4 or IPv6 address (no port, no brackets). */
export const isIpAddress = (value: string): boolean => IPV4.test(value) || IPV6.test(value) || IPV6_V4_TAIL.test(value);

/** Reads HOMEHUB_TRUSTED_PROXY_HOPS (0..5), else the default. */
export const trustedProxyHopsFromEnv = (value: string | undefined): number => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(parsed) && parsed >= 0 && parsed <= 5 ? parsed : DEFAULT_TRUSTED_PROXY_HOPS;
};

/**
 * The client's address: the X-Forwarded-For entry `trustedProxyHops` places left of the
 * rightmost one. Null when the header is absent, has fewer entries than that, or any
 * entry is not a bare IP address (a malformed chain is not trusted at all); callers
 * then rely on the per-instance limit only.
 */
export const clientAddress = (headers: HeaderSource, trustedProxyHops = DEFAULT_TRUSTED_PROXY_HOPS): string | null => {
  const raw = headers.get('x-forwarded-for');
  if (!raw) return null;
  const entries = raw.split(',').map(entry => entry.trim());
  if (entries.some(entry => !isIpAddress(entry))) return null;
  const index = entries.length - 1 - trustedProxyHops;
  if (index < 0) return null;
  return entries[index].toLowerCase();
};

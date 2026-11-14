// The client address used to rate-limit unauthenticated device-code redemption.
//
// The first X-Forwarded-For entry is whatever the client sent, so it is never trusted
// (nor is anything else left of the trusted position: those entries are never parsed).
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

/** The one rate-limit bucket shared by every request whose address cannot be trusted. */
export const UNKNOWN_CLIENT = 'unknown';

/**
 * The client's rate-limit bucket: the X-Forwarded-For entry `trustedProxyHops` places left
 * of the rightmost one, the entry the platform's front end appended. Only that entry is
 * validated: whatever a caller prepends is ignored. When the header is absent, too short,
 * or the trusted entry is not a bare IP address, the answer is `UNKNOWN_CLIENT`, a single
 * bucket that is still rate-limited (the per-address limit is never skipped).
 */
export const clientAddress = (headers: HeaderSource, trustedProxyHops = DEFAULT_TRUSTED_PROXY_HOPS): string => {
  const raw = headers.get('x-forwarded-for');
  if (!raw) return UNKNOWN_CLIENT;
  const entries = raw.split(',');
  const index = entries.length - 1 - trustedProxyHops;
  if (index < 0) return UNKNOWN_CLIENT;
  const trusted = entries[index].trim();
  return isIpAddress(trusted) ? trusted.toLowerCase() : UNKNOWN_CLIENT;
};

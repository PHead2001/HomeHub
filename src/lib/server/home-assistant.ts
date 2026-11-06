import 'server-only';

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class HomeAssistantError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
  }
}

export type HomeAssistantEntitySummary = {
  entity_id: string;
  state: string;
  attributes: { friendly_name?: string; unit_of_measurement?: string; device_class?: string };
};

const MAX_ENTITIES = 1000;
const REQUEST_TIMEOUT_MS = 8000;

const ipv4ToNumber = (ip: string) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
const inV4Range = (ip: string, base: string, bits: number) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(base) & mask);
};

// HomeHub's server runs in Google Cloud. It must never be pointed at loopback,
// private, link-local (metadata server), CGNAT or other non-public addresses.
export const isPublicAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) {
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
      ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([base, bits]) => inV4Range(address, base, bits));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return !(lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff'));
  }
  return false;
};

export type Resolver = (hostname: string) => Promise<string[]>;
const defaultResolver: Resolver = async hostname => (await lookup(hostname, { all: true })).map(entry => entry.address);

const UNREACHABLE_HINT = 'HomeHub connects from the internet, so use an https address that works outside your home network (for example your Nabu Casa or reverse-proxy URL).';

export const normalizeHomeAssistantUrl = async (raw: string, resolve: Resolver = defaultResolver): Promise<string> => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HomeAssistantError('Enter the full address, starting with https://');
  }
  if (url.protocol !== 'https:') throw new HomeAssistantError(`Use an https:// address. ${UNREACHABLE_HINT}`);
  if (url.username || url.password) throw new HomeAssistantError('Remove the username and password from the address.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    throw new HomeAssistantError(`That address only works inside your home. ${UNREACHABLE_HINT}`);
  }
  let addresses: string[];
  try {
    addresses = isIP(host.replace(/^\[|\]$/g, '')) ? [host.replace(/^\[|\]$/g, '')] : await resolve(host);
  } catch {
    throw new HomeAssistantError('That address could not be found. Check the spelling.');
  }
  if (!addresses.length || !addresses.every(isPublicAddress)) {
    throw new HomeAssistantError(`That address points at a private network. ${UNREACHABLE_HINT}`);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
};

export type Fetcher = typeof fetch;

export const fetchHomeAssistantStates = async (
  rawUrl: string,
  accessToken: string,
  { fetchImpl = fetch, resolve = defaultResolver }: { fetchImpl?: Fetcher; resolve?: Resolver } = {}
): Promise<HomeAssistantEntitySummary[]> => {
  // Re-validate on every call: stored URLs predate validation, and DNS can change.
  const base = await normalizeHomeAssistantUrl(rawUrl, resolve);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/states`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HomeAssistantError(`Home Assistant did not answer. ${UNREACHABLE_HINT}`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new HomeAssistantError('Home Assistant redirected the request. Enter the final https address instead.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new HomeAssistantError('Home Assistant rejected the access token. Create a new long-lived token and try again.');
  }
  if (!response.ok) throw new HomeAssistantError(`Home Assistant returned an error (${response.status}).`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HomeAssistantError('That address did not respond like Home Assistant. Check the URL.');
  }
  if (!Array.isArray(body)) throw new HomeAssistantError('That address did not respond like Home Assistant. Check the URL.');

  return body.slice(0, MAX_ENTITIES).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const entity = item as Record<string, unknown>;
    if (typeof entity.entity_id !== 'string') return [];
    const attributes = (entity.attributes && typeof entity.attributes === 'object' ? entity.attributes : {}) as Record<string, unknown>;
    const pick = (key: string) => (typeof attributes[key] === 'string' ? (attributes[key] as string) : undefined);
    return [{
      entity_id: entity.entity_id,
      state: typeof entity.state === 'string' ? entity.state : String(entity.state ?? ''),
      attributes: {
        friendly_name: pick('friendly_name'),
        unit_of_measurement: pick('unit_of_measurement'),
        device_class: pick('device_class'),
      },
    }];
  });
};

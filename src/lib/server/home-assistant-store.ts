import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { HomeAssistantError } from '@/lib/server/home-assistant';
import { getMemberPermissions } from '@/lib/permissions';
import { applyConfigChange, readAutomationConfig, type AutomationConfig } from '@/lib/automation/config';
import { readStoredToken, readTokenKey, storedTokenFields } from '@/lib/automation/token-crypto';
import type { HouseholdMember } from '@/lib/types';

// Home Assistant persistence (docs/modules/home-automation/README.md). Everything under
// households/{h}/home-automation/* is server-only (the rules deny every client):
// `credentials` (address and token, AU-12) and `config` (favourites, rooms, privacy,
// alert rules). The household document carries only `homeAssistant: { connected: true }`
// so the nav and dashboard know whether to ask (AU-6, AU-15); never the token.
// Server-only module: never import it from a 'use server' file's exports.

const householdRef = (householdId: string) => adminDb.collection('households').doc(householdId);
export const credentialsRef = (householdId: string) => householdRef(householdId).collection('home-automation').doc('credentials');
export const configRef = (householdId: string) => householdRef(householdId).collection('home-automation').doc('config');

/** AU-12: the encryption key, read on every call so a new secret needs no rebuild. */
const tokenKey = () => readTokenKey(process.env.HOMEHUB_HA_TOKEN_KEY);

export type StoredCredentials = { url: string; token: string; version: string };

/** The usable credentials, null when not connected; throws when the token can't be read. */
export const readCredentials = async (householdId: string): Promise<StoredCredentials | null> => {
  const snapshot = await credentialsRef(householdId).get();
  const data = snapshot.data();
  if (!snapshot.exists || typeof data?.url !== 'string') return null;
  const token = readStoredToken(data, tokenKey(), householdId);
  if (!token) throw new HomeAssistantError('The saved Home Assistant token can no longer be read. An owner or admin can replace the token.');
  return { url: data.url, token, version: typeof data.updatedAt === 'string' ? data.updatedAt : 'legacy' };
};

/** The connected address (even when the token can't be read), or null when not connected. */
export const readConnectedUrl = async (householdId: string): Promise<string | null> => {
  const url = (await credentialsRef(householdId).get()).get('url');
  return typeof url === 'string' ? url : null;
};

export const readConfig = async (householdId: string): Promise<AutomationConfig> =>
  readAutomationConfig((await configRef(householdId).get()).data());

const memberName = (data: FirebaseFirestore.DocumentData | undefined): string | null =>
  typeof data?.displayName === 'string' && data.displayName.trim() && !data.displayName.includes('@') ? data.displayName.trim() : null;

type Checked = { household: FirebaseFirestore.DocumentReference; actorName: string | null };

/** Inside a transaction: the household exists and is not being deleted; the caller still manages automation. */
const checkManager = async (transaction: FirebaseFirestore.Transaction, householdId: string, uid: string): Promise<Checked> => {
  const household = householdRef(householdId);
  const [snapshot, member] = await Promise.all([transaction.get(household), transaction.get(household.collection('members').doc(uid))]);
  if (!snapshot.exists || snapshot.get('deletingAt')) throw new HomeAssistantError('This household is no longer available.');
  if (!member.exists || !getMemberPermissions(member.data() as HouseholdMember)['automation.manage']) {
    throw new HomeAssistantError('You no longer have permission to change the Home Assistant connection.');
  }
  return { household, actorName: memberName(member.data()) };
};

/** A server-written activity entry (AU-12: who connected, replaced or removed the token). Never the token. */
const audit = (transaction: FirebaseFirestore.Transaction, checked: Checked, uid: string, action: string, now: Date, details: Record<string, string | number | boolean>) => {
  transaction.set(checked.household.collection('auditLogs').doc(), {
    actorUid: uid, actorEmail: null, actorName: checked.actorName, action, createdAt: now.toISOString(), details,
  });
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/**
 * Stores Home Assistant credentials only if, at write time, the household still exists,
 * is not being deleted, and the caller still may manage automation. Saving follows a
 * connection test that can take seconds; re-checking in the same transaction means a
 * household deleted (or a permission revoked) in the meantime never gets its token back.
 * `replace` (AU-9) also requires the same address to still be connected.
 */
export const persistCredentials = async (
  householdId: string,
  uid: string,
  input: { url: string; accessToken: string },
  options: { mode?: 'connect' | 'replace'; now?: Date } = {},
) => {
  const now = options.now ?? new Date();
  const mode = options.mode ?? 'connect';
  await adminDb.runTransaction(async (transaction) => {
    const credentials = credentialsRef(householdId);
    const existing = await transaction.get(credentials);
    const checked = await checkManager(transaction, householdId, uid);
    if (mode === 'replace' && (!existing.exists || existing.get('url') !== input.url)) {
      throw new HomeAssistantError('Home Assistant was disconnected or changed meanwhile. Reload the page.');
    }
    transaction.set(credentials, {
      url: input.url,
      ...storedTokenFields(input.accessToken, tokenKey(), householdId),
      updatedAt: now.toISOString(),
      updatedByUid: uid,
    });
    transaction.update(checked.household, { homeAssistant: { connected: true } });
    audit(transaction, checked, uid, mode === 'replace' ? 'automation.token_replaced' : 'automation.connected', now, {
      host: hostOf(input.url), encrypted: tokenKey() !== null,
    });
  });
};

/** Disconnect: forget the address and token, clear the household flag, log it. Settings are kept. */
export const deleteCredentials = async (householdId: string, uid: string, now = new Date()) => {
  await adminDb.runTransaction(async (transaction) => {
    const credentials = credentialsRef(householdId);
    const existing = await transaction.get(credentials);
    const checked = await checkManager(transaction, householdId, uid);
    transaction.delete(credentials);
    transaction.update(checked.household, { homeAssistant: FieldValue.delete() });
    if (existing.exists) audit(transaction, checked, uid, 'automation.disconnected', now, { host: hostOf(String(existing.get('url') ?? '')) });
  });
};

/**
 * The household's `homeAssistant.connected` flag matches the stored credentials. Households
 * connected before the flag existed get it the first time anyone opens /automation; a
 * stale flag is cleared. The credentials are read in the same transaction as the flag, so
 * a disconnect racing this call can never leave the flag set. Returns whether it wrote.
 */
export const syncConnectedFlag = async (householdId: string): Promise<boolean> => {
  const household = householdRef(householdId);
  return adminDb.runTransaction(async (transaction) => {
    const [snapshot, credentials] = await Promise.all([transaction.get(household), transaction.get(credentialsRef(householdId))]);
    if (!snapshot.exists || snapshot.get('deletingAt')) return false;
    const connected = typeof credentials.get('url') === 'string';
    if ((snapshot.get('homeAssistant.connected') === true) === connected) return false;
    transaction.update(household, { homeAssistant: connected ? { connected: true } : FieldValue.delete() });
    return true;
  });
};

/**
 * Applies one settings change (AU-8, AU-11, AU-13, AU-17) to the config read inside this transaction,
 * after re-checking the caller, and returns the saved config. Throws HomeAssistantError
 * when the change is refused.
 */
export const changeConfig = async (householdId: string, uid: string, change: unknown, now = new Date()): Promise<AutomationConfig> =>
  adminDb.runTransaction(async (transaction) => {
    const previous = await transaction.get(configRef(householdId));
    const checked = await checkManager(transaction, householdId, uid);
    const before = readAutomationConfig(previous.data());
    const next = applyConfigChange(before, change);
    if (!next.ok) throw new HomeAssistantError(next.message);
    transaction.set(configRef(householdId), { ...next.value, updatedAt: now.toISOString(), updatedByUid: uid });
    if (before.showSensitiveToMembers !== next.value.showSensitiveToMembers || before.alerts.length !== next.value.alerts.length) {
      audit(transaction, checked, uid, 'automation.settings_changed', now, {
        showSensitiveToMembers: next.value.showSensitiveToMembers, alerts: next.value.alerts.length,
      });
    }
    return next.value;
  });

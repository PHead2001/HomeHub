// The household's Home Assistant settings (AU-8 favourites, AU-13 rooms, AU-11 privacy,
// AU-17 alert rules). Stored server-only at households/{h}/home-automation/config (the
// rules deny every client) and changed only one setting at a time (ConfigChange)
// (automation.manage). Pure: tests/unit/automation.test.ts.

import { entityDomain, isSensitiveEntity, maySeeSensitive } from './entities';

/** AU-17: "tell us when <entity> has been open/on for N minutes", optionally only between two times. */
export type AlertRule = {
  id: string;
  entityId: string;
  /** Minutes the entity must stay open or on before the notice (0 = at once). */
  minutes: number;
  /** 'HH:mm' in the household's zone; both set or both null (all day). A range may cross midnight. */
  from: string | null;
  to: string | null;
};

export type AutomationConfig = {
  /** AU-8: shown first on /automation and as tiles. */
  favorites: string[];
  /** AU-13: entity id → chore room id, drawn on the house. */
  rooms: Record<string, string>;
  /** AU-11: members (not children or guests) may see people, trackers, cameras and locks. Off by default. */
  showSensitiveToMembers: boolean;
  alerts: AlertRule[];
};

export const EMPTY_AUTOMATION_CONFIG: AutomationConfig = { favorites: [], rooms: {}, showSensitiveToMembers: false, alerts: [] };

export const MAX_FAVORITES = 40;
export const MAX_ROOM_LINKS = 60;
export const MAX_ALERT_RULES = 20;
export const MAX_ALERT_MINUTES = 24 * 60;

const ENTITY_ID = /^[a-z0-9_]{1,64}\.[a-z0-9_]{1,200}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RULE_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const isEntityId = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID.test(value);
const isRoomId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('/');

/** Domains an alert rule may watch: things that open or switch on. Never people, cameras or locks. */
export const ALERT_DOMAINS: ReadonlySet<string> = new Set(['binary_sensor', 'cover', 'light', 'switch', 'fan']);

export const mayWatch = (entityId: string): boolean => ALERT_DOMAINS.has(entityDomain(entityId)) && !isSensitiveEntity(entityId);

/** Drawn on the house: lights, doors and windows, leak sensors (never people, cameras or locks). */
export const HOUSE_DOMAINS: ReadonlySet<string> = new Set(['light', 'binary_sensor', 'cover']);

export const mayPlaceOnHouse = (entityId: string): boolean => HOUSE_DOMAINS.has(entityDomain(entityId)) && !isSensitiveEntity(entityId);

/**
 * What a caller is sent: the privacy choice and alert rules only for managers
 * (automation.manage); sensitive favourites only for those who may see them (AU-11).
 */
export function configForViewer(config: AutomationConfig, viewer: { role: string | null | undefined; canManage: boolean }): AutomationConfig {
  const sensitive = maySeeSensitive(viewer.role, config.showSensitiveToMembers);
  const favorites = sensitive ? config.favorites : config.favorites.filter((id) => !isSensitiveEntity(id));
  if (viewer.canManage) return { ...config, favorites };
  return { favorites, rooms: config.rooms, showSensitiveToMembers: false, alerts: [] };
}

const readRule = (value: unknown): AlertRule | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rule = value as Record<string, unknown>;
  if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) return null;
  if (!isEntityId(rule.entityId) || !mayWatch(rule.entityId)) return null;
  const minutes = typeof rule.minutes === 'number' && Number.isInteger(rule.minutes) ? rule.minutes : NaN;
  if (!(minutes >= 0 && minutes <= MAX_ALERT_MINUTES)) return null;
  const from = rule.from ?? null;
  const to = rule.to ?? null;
  if ((from === null) !== (to === null)) return null;
  if (from !== null && (typeof from !== 'string' || typeof to !== 'string' || !TIME.test(from) || !TIME.test(to) || from === to)) return null;
  return { id: rule.id, entityId: rule.entityId, minutes, from: from as string | null, to: to as string | null };
};

/** The stored config, tolerant: anything malformed is dropped, never thrown. */
export function readAutomationConfig(value: unknown): AutomationConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_AUTOMATION_CONFIG };
  const data = value as Record<string, unknown>;
  const favorites = Array.isArray(data.favorites) ? [...new Set(data.favorites.filter(isEntityId))].slice(0, MAX_FAVORITES) : [];
  const rooms: Record<string, string> = {};
  if (data.rooms && typeof data.rooms === 'object' && !Array.isArray(data.rooms)) {
    for (const [entityId, roomId] of Object.entries(data.rooms as Record<string, unknown>)) {
      if (Object.keys(rooms).length >= MAX_ROOM_LINKS) break;
      if (isEntityId(entityId) && mayPlaceOnHouse(entityId) && isRoomId(roomId)) rooms[entityId] = roomId;
    }
  }
  const alerts = Array.isArray(data.alerts) ? data.alerts.map(readRule).filter((rule): rule is AlertRule => rule !== null).slice(0, MAX_ALERT_RULES) : [];
  return { favorites, rooms, showSensitiveToMembers: data.showSensitiveToMembers === true, alerts };
}

export type ConfigValidation = { ok: true; value: AutomationConfig } | { ok: false; message: string };

/** A submitted config: refused (not trimmed) when anything in it is wrong, so nothing is lost silently. */
export function validateAutomationConfig(input: unknown): ConfigValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Those settings could not be read.' };
  const data = input as Record<string, unknown>;
  if (!Array.isArray(data.favorites) || !data.favorites.every(isEntityId)) return { ok: false, message: 'A favourite is not a Home Assistant device.' };
  if (data.favorites.length > MAX_FAVORITES) return { ok: false, message: `Pin at most ${MAX_FAVORITES} favourites.` };
  if (!data.rooms || typeof data.rooms !== 'object' || Array.isArray(data.rooms)) return { ok: false, message: 'Those rooms could not be read.' };
  const roomEntries = Object.entries(data.rooms as Record<string, unknown>);
  if (roomEntries.length > MAX_ROOM_LINKS) return { ok: false, message: `Place at most ${MAX_ROOM_LINKS} devices on the house.` };
  for (const [entityId, roomId] of roomEntries) {
    if (!isEntityId(entityId) || !isRoomId(roomId)) return { ok: false, message: 'A room choice could not be read.' };
    if (!mayPlaceOnHouse(entityId)) return { ok: false, message: 'Only lights, doors, windows and leak sensors can go on the house.' };
  }
  if (typeof data.showSensitiveToMembers !== 'boolean') return { ok: false, message: 'The privacy choice could not be read.' };
  if (!Array.isArray(data.alerts)) return { ok: false, message: 'Those alerts could not be read.' };
  if (data.alerts.length > MAX_ALERT_RULES) return { ok: false, message: `Keep at most ${MAX_ALERT_RULES} alerts.` };
  const alerts: AlertRule[] = [];
  for (const raw of data.alerts) {
    const rule = readRule(raw);
    if (!rule) return { ok: false, message: 'An alert needs a door, window, light, switch or fan, minutes from 0 to 1440, and either no times or two different times.' };
    alerts.push(rule);
  }
  if (new Set(alerts.map((rule) => rule.id)).size !== alerts.length) return { ok: false, message: 'Two alerts share an id.' };
  return {
    ok: true,
    value: {
      favorites: [...new Set(data.favorites as string[])],
      rooms: Object.fromEntries(roomEntries) as Record<string, string>,
      showSensitiveToMembers: data.showSensitiveToMembers,
      alerts,
    },
  };
}

/**
 * One settings change. The server applies it to the config it reads inside the same
 * transaction that writes it (`changeConfig` in src/lib/server/home-assistant-store.ts),
 * so a page opened earlier never sends back, and never overwrites, settings it did not
 * mean to change (pinning a favourite cannot turn the privacy choice back on).
 */
export type ConfigChange =
  | { kind: 'favorite'; entityId: string; pinned: boolean }
  | { kind: 'room'; entityId: string; roomId: string | null }
  | { kind: 'showSensitiveToMembers'; show: boolean }
  | { kind: 'alertAdd'; rule: AlertRule }
  | { kind: 'alertRemove'; id: string };

/** The current config with one change applied and validated whole, or why it is refused. */
export function applyConfigChange(config: AutomationConfig, change: unknown): ConfigValidation {
  if (!change || typeof change !== 'object' || Array.isArray(change)) return { ok: false, message: 'That change could not be read.' };
  const input = change as Record<string, unknown>;
  switch (input.kind) {
    case 'favorite': {
      if (!isEntityId(input.entityId) || typeof input.pinned !== 'boolean') return { ok: false, message: 'A favourite is not a Home Assistant device.' };
      const rest = config.favorites.filter((id) => id !== input.entityId);
      return validateAutomationConfig({ ...config, favorites: input.pinned ? [...rest, input.entityId] : rest });
    }
    case 'room': {
      if (!isEntityId(input.entityId) || !(input.roomId === null || isRoomId(input.roomId))) return { ok: false, message: 'A room choice could not be read.' };
      const rooms = { ...config.rooms };
      if (input.roomId === null) delete rooms[input.entityId];
      else rooms[input.entityId] = input.roomId;
      return validateAutomationConfig({ ...config, rooms });
    }
    case 'showSensitiveToMembers': {
      if (typeof input.show !== 'boolean') return { ok: false, message: 'The privacy choice could not be read.' };
      return validateAutomationConfig({ ...config, showSensitiveToMembers: input.show });
    }
    case 'alertAdd': {
      const rule = readRule(input.rule);
      if (!rule) return { ok: false, message: 'An alert needs a door, window, light, switch or fan, minutes from 0 to 1440, and either no times or two different times.' };
      if (config.alerts.length >= MAX_ALERT_RULES) return { ok: false, message: `Keep at most ${MAX_ALERT_RULES} alerts.` };
      return validateAutomationConfig({ ...config, alerts: [...config.alerts, rule] });
    }
    case 'alertRemove': {
      if (typeof input.id !== 'string' || !RULE_ID.test(input.id)) return { ok: false, message: 'That alert could not be read.' };
      return validateAutomationConfig({ ...config, alerts: config.alerts.filter((rule) => rule.id !== input.id) });
    }
    default:
      return { ok: false, message: 'That change could not be read.' };
  }
}

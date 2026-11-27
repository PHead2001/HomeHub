// The household's Home Assistant settings (AU-8 favourites, AU-11 privacy). Stored server-only at households/{h}/home-automation/config (the
// rules deny every client) and changed only one setting at a time (ConfigChange)
// (automation.manage). Pure: tests/unit/automation.test.ts.

import { isSensitiveEntity, maySeeSensitive } from './entities';

export type AutomationConfig = {
  /** AU-8: shown first on /automation and as tiles. */
  favorites: string[];
  /** AU-11: members (not children or guests) may see people, trackers, cameras and locks. Off by default. */
  showSensitiveToMembers: boolean;
};

export const EMPTY_AUTOMATION_CONFIG: AutomationConfig = { favorites: [], showSensitiveToMembers: false };

export const MAX_FAVORITES = 40;

const ENTITY_ID = /^[a-z0-9_]{1,64}\.[a-z0-9_]{1,200}$/;

export const isEntityId = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID.test(value);

/**
 * What a caller is sent: the privacy choice only for managers
 * (automation.manage); sensitive favourites only for those who may see them (AU-11).
 */
export function configForViewer(config: AutomationConfig, viewer: { role: string | null | undefined; canManage: boolean }): AutomationConfig {
  const sensitive = maySeeSensitive(viewer.role, config.showSensitiveToMembers);
  const favorites = sensitive ? config.favorites : config.favorites.filter((id) => !isSensitiveEntity(id));
  if (viewer.canManage) return { ...config, favorites };
  return { favorites, showSensitiveToMembers: false };
}

/** The stored config, tolerant: anything malformed is dropped, never thrown. */
export function readAutomationConfig(value: unknown): AutomationConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_AUTOMATION_CONFIG };
  const data = value as Record<string, unknown>;
  const favorites = Array.isArray(data.favorites) ? [...new Set(data.favorites.filter(isEntityId))].slice(0, MAX_FAVORITES) : [];
  return { favorites, showSensitiveToMembers: data.showSensitiveToMembers === true };
}

export type ConfigValidation = { ok: true; value: AutomationConfig } | { ok: false; message: string };

/** A submitted config: refused (not trimmed) when anything in it is wrong, so nothing is lost silently. */
export function validateAutomationConfig(input: unknown): ConfigValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Those settings could not be read.' };
  const data = input as Record<string, unknown>;
  if (!Array.isArray(data.favorites) || !data.favorites.every(isEntityId)) return { ok: false, message: 'A favourite is not a Home Assistant device.' };
  if (data.favorites.length > MAX_FAVORITES) return { ok: false, message: `Pin at most ${MAX_FAVORITES} favourites.` };
  if (typeof data.showSensitiveToMembers !== 'boolean') return { ok: false, message: 'The privacy choice could not be read.' };
  return {
    ok: true,
    value: {
      favorites: [...new Set(data.favorites as string[])],
      showSensitiveToMembers: data.showSensitiveToMembers,
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
  | { kind: 'showSensitiveToMembers'; show: boolean };

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
    case 'showSensitiveToMembers': {
      if (typeof input.show !== 'boolean') return { ok: false, message: 'The privacy choice could not be read.' };
      return validateAutomationConfig({ ...config, showSensitiveToMembers: input.show });
    }
    default:
      return { ok: false, message: 'That change could not be read.' };
  }
}

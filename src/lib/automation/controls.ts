// AU-14: the only things HomeHub may switch. Pure: the server action decides with it
// (src/app/automation/actions.ts) and the page uses it to decide what to offer.
// Lights, scenes and fans only; never locks, alarms, garage doors, covers or cameras.

import { entityDomain, type HomeAssistantEntitySummary } from './entities';

export const CONTROLLABLE_DOMAINS = ['light', 'fan', 'scene'] as const;
export type ControllableDomain = (typeof CONTROLLABLE_DOMAINS)[number];
export type ControlRequest = 'on' | 'off';

/** A real Home Assistant entity id in one of the safe domains (nothing else reaches HA). */
const SAFE_ENTITY_ID = /^(light|fan|scene)\.[a-z0-9_]{1,200}$/;

export const isControllable = (entityId: string): boolean => SAFE_ENTITY_ID.test(entityId);

/**
 * The fixed Home Assistant service for a request: explicit on or off (never toggle, so a
 * retried tap cannot undo itself); a scene can only be turned on. Null when refused.
 */
export function controlService(entityId: unknown, desired: unknown): { domain: ControllableDomain; service: 'turn_on' | 'turn_off'; entityId: string } | null {
  if (typeof entityId !== 'string' || !isControllable(entityId)) return null;
  if (desired !== 'on' && desired !== 'off') return null;
  const domain = entityDomain(entityId) as ControllableDomain;
  if (domain === 'scene' && desired === 'off') return null;
  return { domain, service: desired === 'on' ? 'turn_on' : 'turn_off', entityId };
}

/**
 * A scene is safe only when Home Assistant lists what it sets and every member is a light
 * or a fan: a scene can also unlock a door or open a garage, so one that touches anything
 * else, or does not say, is never offered or run.
 */
export function isSafeScene(entity: Pick<HomeAssistantEntitySummary, 'entity_id' | 'attributes'> | undefined): boolean {
  if (!entity || entityDomain(entity.entity_id) !== 'scene') return false;
  const members = entity.attributes.entity_id;
  return Array.isArray(members) && members.length > 0 && members.every((id) => /^(light|fan)\.[a-z0-9_]+$/.test(id));
}

/** What a control tile shows for an entity, or null when it is not controllable. */
export function controlFor(entity: HomeAssistantEntitySummary): { kind: 'switch'; on: boolean } | { kind: 'scene' } | null {
  if (!isControllable(entity.entity_id)) return null;
  if (entityDomain(entity.entity_id) === 'scene') return isSafeScene(entity) ? { kind: 'scene' } : null;
  if (entity.state === 'unavailable' || entity.state === 'unknown') return null;
  return { kind: 'switch', on: entity.state === 'on' };
}

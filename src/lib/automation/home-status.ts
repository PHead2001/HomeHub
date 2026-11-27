// AU-15 "Home status" and AU-13 devices on the house drawing. Pure: computed on the
// server from the cached states (after the AU-11 privacy filter) and drawn by the
// dashboard. tests/unit/automation-home-status.test.ts.

import { batteryPercent, entityDomain, entityName, isLowBattery, isSensitiveEntity, type HomeAssistantEntitySummary } from './entities';

/** A door or window open this long is a warning on the card (AU-15). */
export const DOOR_WARNING_MINUTES = 10;

const OPENING_CLASSES = new Set(['door', 'window', 'garage_door', 'opening']);
const COVER_DOOR_CLASSES = new Set(['garage', 'door', 'gate']);
const OUTSIDE = /outdoor|outside|exterior|garden|patio|weather|freezer|fridge|refrigerator|attic|pool/i;

export const isOpening = (entity: HomeAssistantEntitySummary): boolean => {
  const domain = entityDomain(entity.entity_id);
  const deviceClass = entity.attributes.device_class ?? '';
  if (domain === 'binary_sensor') return OPENING_CLASSES.has(deviceClass);
  return domain === 'cover' && COVER_DOOR_CLASSES.has(deviceClass);
};

export const isOpen = (entity: HomeAssistantEntitySummary): boolean =>
  isOpening(entity) && (entity.state === 'on' || entity.state === 'open' || entity.state === 'opening');

export const isLeak = (entity: HomeAssistantEntitySummary): boolean =>
  entityDomain(entity.entity_id) === 'binary_sensor' && entity.attributes.device_class === 'moisture' && entity.state === 'on';

export const isLightOn = (entity: HomeAssistantEntitySummary): boolean =>
  entityDomain(entity.entity_id) === 'light' && entity.state === 'on';

/** Minutes since the state changed, or null when Home Assistant did not say. */
export const minutesSince = (entity: HomeAssistantEntitySummary, now: Date): number | null => {
  const at = entity.last_changed ? Date.parse(entity.last_changed) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60000)) : null;
};

export type HomeStatus = {
  lightsOn: number;
  doorsOpen: Array<{ entityId: string; name: string; minutes: number | null }>;
  leaks: Array<{ entityId: string; name: string }>;
  lowBatteries: Array<{ entityId: string; name: string; percent: number | null }>;
  insideTemperature: string | null;
  unavailable: number;
  /** "All doors closed · 2 lights on · 71 °F inside". */
  line: string;
  /** Plain-language warnings, worst first: leaks, doors open 10+ min, low batteries. */
  warnings: string[];
};

const insideTemperature = (entities: readonly HomeAssistantEntitySummary[]): string | null => {
  for (const entity of entities) {
    if (entityDomain(entity.entity_id) !== 'climate') continue;
    const value = entity.attributes.current_temperature;
    if (typeof value === 'number' && Number.isFinite(value)) return `${Math.round(value)}${entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : '°'}`;
  }
  const sensor = entities.find((entity) => entityDomain(entity.entity_id) === 'sensor'
    && entity.attributes.device_class === 'temperature'
    && /^-?\d+(\.\d+)?$/.test(entity.state)
    && !OUTSIDE.test(`${entity.entity_id} ${entity.attributes.friendly_name ?? ''}`));
  if (!sensor) return null;
  return `${Math.round(Number(sensor.state))}${sensor.attributes.unit_of_measurement ? ` ${sensor.attributes.unit_of_measurement}` : '°'}`;
};

/** The card's facts. Sensitive entities (people, cameras, locks) are never counted. */
export function homeStatus(all: readonly HomeAssistantEntitySummary[], now: Date): HomeStatus {
  const entities = all.filter((entity) => !isSensitiveEntity(entity.entity_id));
  const lightsOn = entities.filter(isLightOn).length;
  const doorsOpen = entities.filter(isOpen).map((entity) => ({ entityId: entity.entity_id, name: entityName(entity), minutes: minutesSince(entity, now) }));
  const leaks = entities.filter(isLeak).map((entity) => ({ entityId: entity.entity_id, name: entityName(entity) }));
  const lowBatteries = entities.filter(isLowBattery).map((entity) => ({ entityId: entity.entity_id, name: entityName(entity), percent: batteryPercent(entity) }));
  const inside = insideTemperature(entities);
  const anyOpenings = entities.some(isOpening);
  const parts = [
    anyOpenings ? (doorsOpen.length === 0 ? 'All doors closed' : `${doorsOpen.length} ${doorsOpen.length === 1 ? 'door or window' : 'doors or windows'} open`) : null,
    entities.some((entity) => entityDomain(entity.entity_id) === 'light') ? (lightsOn === 0 ? 'Lights off' : `${lightsOn} ${lightsOn === 1 ? 'light' : 'lights'} on`) : null,
    inside ? `${inside} inside` : null,
  ].filter((part): part is string => Boolean(part));
  const warnings = [
    ...leaks.map((leak) => `Leak: ${leak.name}`),
    ...doorsOpen.filter((door) => door.minutes !== null && door.minutes >= DOOR_WARNING_MINUTES)
      .sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))
      .map((door) => `${door.name} open ${door.minutes} min`),
    ...lowBatteries.map((battery) => `Low battery: ${battery.name}${battery.percent !== null ? ` (${battery.percent}%)` : ''}`),
  ];
  return {
    lightsOn,
    doorsOpen,
    leaks,
    lowBatteries,
    insideTemperature: inside,
    unavailable: entities.filter((entity) => entity.state === 'unavailable').length,
    line: parts.length ? parts.join(' · ') : 'Connected',
    warnings,
  };
}

/** AU-13: what one chore room shows on the house drawing. */
/** `lights`: Home Assistant lights placed in the room; when there are any, its window follows them. */
export type RoomDevices = { lights: number; lightsOn: number; open: number; leak: boolean; names: string[] };

/**
 * The house marks per chore room from the household's room links: a lit window when a
 * light is on, an open-door mark, a red drop for a leak. Links to entities that are
 * gone, sensitive, or not a light, opening or leak sensor are skipped.
 */
export function houseDevices(entities: readonly HomeAssistantEntitySummary[], rooms: Readonly<Record<string, string>>): Record<string, RoomDevices> {
  const byId = new Map(entities.map((entity) => [entity.entity_id, entity]));
  const result: Record<string, RoomDevices> = {};
  for (const [entityId, roomId] of Object.entries(rooms)) {
    const entity = byId.get(entityId);
    if (!entity || isSensitiveEntity(entityId)) continue;
    const light = entityDomain(entityId) === 'light';
    if (!light && !isOpening(entity) && entity.attributes.device_class !== 'moisture') continue;
    const room = result[roomId] ?? { lights: 0, lightsOn: 0, open: 0, leak: false, names: [] };
    if (light) room.lights += 1;
    if (isLightOn(entity)) room.lightsOn += 1;
    if (isOpen(entity)) room.open += 1;
    if (isLeak(entity)) room.leak = true;
    if (isLightOn(entity) || isOpen(entity) || isLeak(entity)) room.names.push(entityName(entity));
    result[roomId] = room;
  }
  return result;
}

/** "Kitchen light on, Back door open" for a room link's accessible name. */
export const roomDevicesLabel = (room: RoomDevices | undefined): string | null => {
  if (!room) return null;
  const parts = [
    room.leak ? 'leak detected' : null,
    room.open ? `${room.open} open` : null,
    room.lightsOn ? `${room.lightsOn} ${room.lightsOn === 1 ? 'light' : 'lights'} on` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
};

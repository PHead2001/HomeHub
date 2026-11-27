// Pure helpers for Home Assistant entities (docs/modules/home-automation/README.md).
// Shared by the server (privacy filter, home status, alerts) and the /automation page
// (grouping, labels). No server-only imports: tests/unit/automation-*.test.ts.

/** One Home Assistant entity as HomeHub keeps it: a trimmed copy of `/api/states`. */
export type HomeAssistantEntitySummary = {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    unit_of_measurement?: string;
    device_class?: string;
  };
  /** ISO time the state last changed (AU-3), when Home Assistant sent one. */
  last_changed?: string;
};

export const entityDomain = (entityId: string): string => entityId.split('.')[0] || 'other';

export const entityName = (entity: Pick<HomeAssistantEntitySummary, 'entity_id' | 'attributes'>): string =>
  entity.attributes.friendly_name?.trim() || entity.entity_id;

/**
 * AU-2: domains that are Home Assistant's own plumbing, hidden unless "Show all" is on.
 * A typical house has hundreds of these; the useful devices are lights, sensors, doors.
 */
export const SYSTEM_DOMAINS: ReadonlySet<string> = new Set([
  'update', 'sun', 'zone', 'automation', 'script', 'button', 'number', 'input_boolean', 'input_number',
  'input_select', 'input_text', 'input_datetime', 'input_button', 'select', 'text', 'counter', 'timer',
  'event', 'conversation', 'tts', 'stt', 'wake_word', 'image', 'persistent_notification', 'schedule',
  'todo', 'calendar', 'device_tracker_config', 'notify', 'assist_satellite', 'time', 'date', 'datetime',
]);

/** Diagnostic sensors that are noise in a device list (signal strength, uptime and so on). */
const DIAGNOSTIC_CLASSES: ReadonlySet<string> = new Set([
  'signal_strength', 'data_rate', 'data_size', 'duration', 'frequency', 'voltage', 'current', 'power_factor',
  'apparent_power', 'reactive_power', 'sound_pressure', 'update', 'connectivity', 'running',
]);

/** A low battery is worth seeing even with system items hidden (AU-3, AU-16). */
export const LOW_BATTERY_PERCENT = 20;

const numeric = (state: string): number | null => {
  if (!/^-?\d+(\.\d+)?$/.test(state.trim())) return null;
  const value = Number(state);
  return Number.isFinite(value) ? value : null;
};

export const batteryPercent = (entity: HomeAssistantEntitySummary): number | null =>
  entityDomain(entity.entity_id) === 'sensor' && entity.attributes.device_class === 'battery' ? numeric(entity.state) : null;

export const isLowBattery = (entity: HomeAssistantEntitySummary): boolean => {
  const percent = batteryPercent(entity);
  if (percent !== null) return percent <= LOW_BATTERY_PERCENT;
  return entityDomain(entity.entity_id) === 'binary_sensor' && entity.attributes.device_class === 'battery' && entity.state === 'on';
};

/** AU-2: hidden by default ("Show all" shows it). Low batteries always show. */
export function isNoiseEntity(entity: HomeAssistantEntitySummary): boolean {
  const domain = entityDomain(entity.entity_id);
  if (SYSTEM_DOMAINS.has(domain)) return true;
  const deviceClass = entity.attributes.device_class ?? '';
  if (deviceClass === 'battery') return !isLowBattery(entity);
  if ((domain === 'sensor' || domain === 'binary_sensor') && DIAGNOSTIC_CLASSES.has(deviceClass)) return true;
  if (domain === 'sensor' && /(_rssi|_linkquality|_signal|_uptime|_last_seen)$/.test(entity.entity_id)) return true;
  return false;
}

const DOOR_CLASSES = new Set(['door', 'window', 'garage_door', 'opening']);
const MOTION_CLASSES = new Set(['motion', 'occupancy', 'presence', 'moving']);
const SAFETY_CLASSES = new Set(['smoke', 'gas', 'carbon_monoxide', 'safety', 'problem', 'tamper', 'heat', 'cold']);

/** AU-2, AU-3: the group an entity is listed under, from its domain and device class. */
export function entityGroup(entity: HomeAssistantEntitySummary): string {
  const domain = entityDomain(entity.entity_id);
  const deviceClass = entity.attributes.device_class ?? '';
  if (domain === 'binary_sensor') {
    if (DOOR_CLASSES.has(deviceClass)) return 'Doors and windows';
    if (MOTION_CLASSES.has(deviceClass)) return 'Motion';
    if (deviceClass === 'moisture') return 'Leaks';
    if (SAFETY_CLASSES.has(deviceClass)) return 'Smoke and safety';
    if (deviceClass === 'battery') return 'Batteries';
    return 'Sensors';
  }
  if (domain === 'sensor') {
    if (deviceClass === 'battery') return 'Batteries';
    if (deviceClass === 'temperature' || deviceClass === 'humidity') return 'Climate';
    if (deviceClass === 'power' || deviceClass === 'energy') return 'Energy';
    return 'Sensors';
  }
  if (domain === 'cover' && (deviceClass === 'garage' || deviceClass === 'door' || deviceClass === 'gate')) return 'Doors and windows';
  const labels: Record<string, string> = {
    light: 'Lights', switch: 'Switches', climate: 'Climate', lock: 'Locks', cover: 'Covers and blinds',
    media_player: 'Media', fan: 'Fans', camera: 'Cameras', person: 'People', device_tracker: 'People',
    weather: 'Weather', alarm_control_panel: 'Security', scene: 'Scenes', script: 'Scripts', update: 'Updates',
    button: 'Buttons', input_button: 'Buttons', vacuum: 'Vacuums', water_heater: 'Climate', humidifier: 'Climate',
    automation: 'Automations', sun: 'Other', zone: 'Other',
  };
  return labels[domain] ?? 'Other';
}

export type EntityStateTone = 'on' | 'off' | 'alert' | 'unavailable' | 'value';

/** Binary sensor wording by device class: [state when on, state when off]. */
const BINARY_WORDS: Record<string, [string, string]> = {
  door: ['Open', 'Closed'], window: ['Open', 'Closed'], garage_door: ['Open', 'Closed'], opening: ['Open', 'Closed'],
  motion: ['Motion', 'Clear'], occupancy: ['Occupied', 'Clear'], presence: ['Home', 'Away'], moving: ['Moving', 'Still'],
  moisture: ['Wet', 'Dry'], smoke: ['Smoke', 'Clear'], gas: ['Gas', 'Clear'], carbon_monoxide: ['CO detected', 'Clear'],
  safety: ['Unsafe', 'Safe'], problem: ['Problem', 'OK'], tamper: ['Tampered', 'OK'], battery: ['Low', 'Normal'],
  heat: ['Hot', 'Normal'], cold: ['Cold', 'Normal'], lock: ['Unlocked', 'Locked'], plug: ['Plugged in', 'Unplugged'],
  power: ['Power', 'No power'], light: ['Light', 'Dark'], sound: ['Sound', 'Quiet'], vibration: ['Vibration', 'Still'],
  connectivity: ['Connected', 'Disconnected'], running: ['Running', 'Stopped'], update: ['Update available', 'Up to date'],
};

/** Classes whose "on" needs attention (a leak, smoke, an open door is only "on"). */
const ALERT_WHEN_ON = new Set(['moisture', 'smoke', 'gas', 'carbon_monoxide', 'safety', 'problem', 'tamper', 'battery', 'heat', 'cold']);

const ON = new Set(['on', 'open', 'home', 'playing', 'unlocked', 'heat', 'cool', 'heat_cool', 'auto', 'armed_home', 'armed_away', 'armed_night', 'active']);
const OFF = new Set(['off', 'closed', 'not_home', 'away', 'idle', 'paused', 'standby', 'locked', 'disarmed', 'inactive']);
const ALERT = new Set(['triggered', 'problem', 'jammed', 'unlocking', 'locking', 'opening', 'closing', 'pending', 'arming']);
const UNAVAILABLE = new Set(['unavailable', 'unknown', 'none', '']);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** "3 min", "2 h", "4 days": how long ago (or "just now"). */
export function sinceLabel(iso: string | undefined | null, now: Date): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** A timestamp sensor's value in the household's zone: "Tue 27 Nov, 14:05". */
export function formatEntityTime(iso: string, timeZone: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
  } catch {
    return null;
  }
}

export type EntityStateView = { label: string; tone: EntityStateTone };

/**
 * AU-3: the state in plain words, with a tone. Binary sensors use their device class
 * ("Front door: Open", "Leak: Wet"); timestamp sensors are formatted in the household's
 * zone; numbers keep their unit.
 */
export function describeEntityState(entity: HomeAssistantEntitySummary, timeZone = 'UTC'): EntityStateView {
  const raw = (entity.state ?? '').trim();
  const lower = raw.toLowerCase();
  if (UNAVAILABLE.has(lower)) return { label: lower === 'unavailable' ? 'Unavailable' : lower === 'unknown' ? 'Unknown' : 'No state', tone: 'unavailable' };
  const domain = entityDomain(entity.entity_id);
  const deviceClass = entity.attributes.device_class ?? '';
  if (domain === 'binary_sensor' && (lower === 'on' || lower === 'off')) {
    const words = BINARY_WORDS[deviceClass];
    const on = lower === 'on';
    const label = words ? words[on ? 0 : 1] : on ? 'On' : 'Off';
    const tone: EntityStateTone = on ? (ALERT_WHEN_ON.has(deviceClass) ? 'alert' : 'on') : 'off';
    return { label, tone };
  }
  if (deviceClass === 'timestamp' || ISO_TIME.test(raw)) {
    const formatted = formatEntityTime(raw, timeZone);
    if (formatted) return { label: formatted, tone: 'value' };
  }
  if (batteryPercent(entity) !== null) {
    return { label: `${raw}${entity.attributes.unit_of_measurement ?? '%'}`, tone: isLowBattery(entity) ? 'alert' : 'value' };
  }
  return { label: entityStateLabel(raw, entity.attributes.unit_of_measurement), tone: entityStateTone(raw) };
}

/** Color tone for a raw state. Numbers and free text are neutral values. */
export function entityStateTone(state: string | null | undefined): EntityStateTone {
  const value = (state ?? '').trim().toLowerCase();
  if (UNAVAILABLE.has(value)) return 'unavailable';
  if (ON.has(value)) return 'on';
  if (OFF.has(value)) return 'off';
  if (ALERT.has(value)) return 'alert';
  return 'value';
}

/** "not_home" → "Not home", "21.5" + "°C" → "21.5 °C"; free text is kept. */
export function entityStateLabel(state: string | null | undefined, unit?: string | null): string {
  const raw = (state ?? '').trim();
  if (!raw || raw.toLowerCase() === 'none') return 'No state';
  const tone = entityStateTone(raw);
  if (tone !== 'value') {
    const words = raw.toLowerCase().replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return unit ? `${raw} ${unit}` : raw;
}

/** Groups in a stable order: what people check most first, plumbing last. */
const GROUP_ORDER = [
  'Lights', 'Doors and windows', 'Leaks', 'Smoke and safety', 'Motion', 'Climate', 'Fans', 'Scenes', 'Switches',
  'Covers and blinds', 'Locks', 'Security', 'Cameras', 'People', 'Media', 'Vacuums', 'Energy', 'Batteries', 'Sensors',
  'Weather', 'Scripts', 'Automations', 'Buttons', 'Updates', 'Other',
];

export type EntityListOptions = { showAll: boolean; search: string; favorites?: readonly string[] };

/** AU-2, AU-8: favourites first, then grouped; system noise hidden unless `showAll`. */
export function arrangeEntities(entities: readonly HomeAssistantEntitySummary[], options: EntityListOptions) {
  const term = options.search.trim().toLowerCase();
  const favorites = new Set(options.favorites ?? []);
  const matches = (entity: HomeAssistantEntitySummary) => !term
    || entity.entity_id.toLowerCase().includes(term)
    || entityName(entity).toLowerCase().includes(term);
  const visible = entities.filter((entity) => matches(entity) && (options.showAll || favorites.has(entity.entity_id) || !isNoiseEntity(entity)));
  const hiddenCount = entities.filter((entity) => matches(entity) && !options.showAll && !favorites.has(entity.entity_id) && isNoiseEntity(entity)).length;
  const byName = (a: HomeAssistantEntitySummary, b: HomeAssistantEntitySummary) => entityName(a).localeCompare(entityName(b));
  const pinned = visible.filter((entity) => favorites.has(entity.entity_id)).sort(byName);
  const groups = new Map<string, HomeAssistantEntitySummary[]>();
  for (const entity of visible) {
    if (favorites.has(entity.entity_id)) continue;
    const label = entityGroup(entity);
    groups.set(label, [...(groups.get(label) ?? []), entity]);
  }
  const rank = (label: string) => {
    const index = GROUP_ORDER.indexOf(label);
    return index === -1 ? GROUP_ORDER.length : index;
  };
  const grouped = [...groups.entries()]
    .map(([label, items]) => [label, items.sort(byName)] as [string, HomeAssistantEntitySummary[]])
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  return { favorites: pinned, groups: grouped, hiddenCount };
}

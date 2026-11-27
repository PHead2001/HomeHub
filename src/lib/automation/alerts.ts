// AU-16 (maintenance from sensors) and AU-17 (automation notifications). Pure: the
// server runs it each time it fetches fresh states for a household
// (src/lib/server/home-assistant-alerts.ts) and writes one notification per notice,
// under a deterministic id, so the same event never notifies twice.
// tests/unit/automation-alerts.test.ts.

import { localDay, localMinutes, parseTimeOfDay, safeTimeZone } from '@functions/shared/calendar';
import { batteryPercent, entityDomain, entityName, isLowBattery, isSensitiveEntity, type HomeAssistantEntitySummary } from './entities';
import type { AlertRule } from './config';
import { isLeak, minutesSince } from './home-status';

export type AlertNotice = {
  /** Notification document id: the same event always maps to the same id. */
  id: string;
  category: 'automation' | 'maintenance';
  title: string;
  message: string;
  /** Leaks and smoke: pushed even during quiet hours. */
  urgent: boolean;
  sourceType: 'ha-leak' | 'ha-safety' | 'ha-battery' | 'ha-filter' | 'ha-rule';
  sourceId: string;
  deepLink: string;
};

const slug = (entityId: string) => entityId.replace(/[^a-z0-9_]/gi, '_').slice(0, 120);
const changedKey = (entity: HomeAssistantEntitySummary) => {
  const at = entity.last_changed ? Date.parse(entity.last_changed) : NaN;
  return Number.isFinite(at) ? String(at) : 'unknown';
};

const SAFETY_CLASSES: Record<string, string> = { smoke: 'Smoke detected', carbon_monoxide: 'Carbon monoxide detected', gas: 'Gas detected' };

/** Whether an entity counts as "open or on" for a rule. */
export function isActive(entity: HomeAssistantEntitySummary): boolean {
  const domain = entityDomain(entity.entity_id);
  if (domain === 'cover') return entity.state === 'open' || entity.state === 'opening';
  return entity.state === 'on';
}

/** Whether `now` (household zone) is inside a rule's window; a rule without times is all day. */
export function inRuleWindow(rule: Pick<AlertRule, 'from' | 'to'>, timeZone: string, now: Date): boolean {
  if (!rule.from || !rule.to) return true;
  const start = parseTimeOfDay(rule.from);
  const end = parseTimeOfDay(rule.to);
  if (start === null || end === null || start === end) return true;
  const minute = localMinutes(now, safeTimeZone(timeZone));
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

const isFilterDue = (entity: HomeAssistantEntitySummary): boolean => {
  const text = `${entity.entity_id} ${entity.attributes.friendly_name ?? ''}`.toLowerCase();
  if (!text.includes('filter')) return false;
  const domain = entityDomain(entity.entity_id);
  if (domain === 'binary_sensor') return entity.state === 'on';
  if (domain === 'sensor' && /^-?\d+(\.\d+)?$/.test(entity.state)) {
    const value = Number(entity.state);
    const unit = (entity.attributes.unit_of_measurement ?? '').toLowerCase();
    if (unit === '%') return value <= 10;
    if (unit === 'd' || unit === 'days' || unit === 'h') return value <= 0;
  }
  return false;
};

const describeActive = (entity: HomeAssistantEntitySummary) => (entityDomain(entity.entity_id) === 'cover' || entityDomain(entity.entity_id) === 'binary_sensor' ? 'open' : 'on');

const ruleWindowText = (rule: AlertRule) => (rule.from && rule.to ? ` (alert between ${rule.from} and ${rule.to})` : '');

/**
 * Everything that should notify now. People, trackers, cameras and locks never do
 * (AU-11: these notices reach every member who can view automation).
 */
export function evaluateAlerts(input: {
  entities: readonly HomeAssistantEntitySummary[];
  rules: readonly AlertRule[];
  timeZone: string;
  now: Date;
}): AlertNotice[] {
  const { now } = input;
  const zone = safeTimeZone(input.timeZone);
  const month = localDay(now, zone).slice(0, 7);
  const entities = input.entities.filter((entity) => !isSensitiveEntity(entity.entity_id));
  const notices: AlertNotice[] = [];
  for (const entity of entities) {
    const name = entityName(entity);
    if (isLeak(entity)) {
      notices.push({
        id: `ha-leak-${slug(entity.entity_id)}-${changedKey(entity)}`, category: 'automation', urgent: true,
        title: `Water leak: ${name}`, message: `${name} detected water. Check it now.`,
        sourceType: 'ha-leak', sourceId: entity.entity_id, deepLink: '/automation',
      });
      continue;
    }
    const safety = entityDomain(entity.entity_id) === 'binary_sensor' ? SAFETY_CLASSES[entity.attributes.device_class ?? ''] : undefined;
    if (safety && entity.state === 'on') {
      notices.push({
        id: `ha-safety-${slug(entity.entity_id)}-${changedKey(entity)}`, category: 'automation', urgent: true,
        title: `${safety}: ${name}`, message: `${name} reports: ${safety.toLowerCase()}.`,
        sourceType: 'ha-safety', sourceId: entity.entity_id, deepLink: '/automation',
      });
      continue;
    }
    // AU-16: at most one maintenance reminder per device per month (household zone).
    if (isLowBattery(entity)) {
      const percent = batteryPercent(entity);
      notices.push({
        id: `ha-battery-${slug(entity.entity_id)}-${month}`, category: 'maintenance', urgent: false,
        title: `Replace the battery: ${name}`,
        message: percent !== null ? `${name} is at ${percent}%. Replace the battery soon.` : `${name} reports a low battery. Replace it soon.`,
        sourceType: 'ha-battery', sourceId: entity.entity_id, deepLink: '/maintenance',
      });
      continue;
    }
    if (isFilterDue(entity)) {
      notices.push({
        id: `ha-filter-${slug(entity.entity_id)}-${month}`, category: 'maintenance', urgent: false,
        title: `Replace the filter: ${name}`, message: `${name} says the filter needs replacing.`,
        sourceType: 'ha-filter', sourceId: entity.entity_id, deepLink: '/maintenance',
      });
    }
  }
  const byId = new Map(entities.map((entity) => [entity.entity_id, entity]));
  for (const rule of input.rules) {
    const entity = byId.get(rule.entityId);
    if (!entity || !isActive(entity)) continue;
    const minutes = minutesSince(entity, now);
    // Without a change time the duration is unknown: only an "at once" rule may fire.
    if (minutes === null ? rule.minutes > 0 : minutes < rule.minutes) continue;
    if (!inRuleWindow(rule, zone, now)) continue;
    const name = entityName(entity);
    const state = describeActive(entity);
    notices.push({
      id: `ha-rule-${rule.id}-${changedKey(entity)}`, category: 'automation', urgent: false,
      title: `${name} is ${state}`,
      message: minutes !== null && minutes > 0 ? `${name} has been ${state} for ${minutes} min${ruleWindowText(rule)}.` : `${name} is ${state}${ruleWindowText(rule)}.`,
      sourceType: 'ha-rule', sourceId: rule.id, deepLink: '/automation',
    });
  }
  return notices;
}

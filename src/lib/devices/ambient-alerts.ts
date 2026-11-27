import type { DashboardFacts } from '@/lib/dashboard/facts';
import type { DeviceSections } from './types';

/**
 * HP-16: what the tablet's ambient clock screen still says while it rests: only
 * things that need doing, as household counts (never a name, chore or pet: WT-5a).
 * Sections switched off on the tablet (WT-11) say nothing; unknown counts (still
 * loading, or unreadable) are never shown as zero, they are left out.
 */
export function ambientAlerts(facts: DashboardFacts | null | undefined, sections: DeviceSections, notices: number): string[] {
  const alerts: string[] = [];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (sections.chores && facts?.chores && facts.chores.overdueTotal > 0) {
    alerts.push(count(facts.chores.overdueTotal, 'chore overdue', 'chores overdue'));
  }
  if (sections.pets && facts?.pets && facts.pets.hungry > 0) {
    alerts.push(count(facts.pets.hungry, 'pet needs a meal', 'pets need a meal'));
  }
  if (sections.maintenance && facts?.maintenance && facts.maintenance.overdue > 0) {
    alerts.push(count(facts.maintenance.overdue, 'maintenance item overdue', 'maintenance items overdue'));
  }
  if (notices > 0) alerts.push(count(notices, 'household notice', 'household notices'));
  return alerts;
}

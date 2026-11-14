'use client';

/**
 * Who the dashboard is drawn for. A signed-in person by default (from `useAuth`); a
 * registered wall tablet provides its own scope (docs/modules/devices/README.md,
 * "Tablet shell"): the household it belongs to, no viewer of its own (so the brief and
 * tiles use household totals, HP-3b/HP-21), view permissions from the tablet's sections
 * only (no write permission, so no one-tap or quick-add control appears: a tablet is
 * read-only until its device actions exist), and `kind: 'device'`, which hides the
 * desktop-only affordances (Home Wrapped download, keyboard hints; D-T15) and the AI
 * rewrite of the brief (JC-28).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useAuth } from '@/hooks/use-auth';
import type { HouseholdPermission } from '@/lib/types';

export type DashboardScope = {
  kind: 'personal' | 'device';
  householdId: string | null;
  householdName: string | null;
  timeZone: string | null;
  /** The reader ('' on a tablet: nothing is "yours"). */
  uid: string;
  email: string;
  /** First name for the greeting (never on a tablet). */
  greetingName: string | null;
  permissions: Record<HouseholdPermission, boolean>;
};

const DashboardScopeContext = createContext<DashboardScope | null>(null);

export function DashboardScopeProvider({ value, children }: { value: DashboardScope; children: ReactNode }) {
  return <DashboardScopeContext.Provider value={value}>{children}</DashboardScopeContext.Provider>;
}

export function useDashboardScope(): DashboardScope {
  const provided = useContext(DashboardScopeContext);
  const { currentUser, household, permissions } = useAuth();
  if (provided) return provided;
  return {
    kind: 'personal',
    householdId: currentUser?.householdId ?? null,
    householdName: household?.name ?? null,
    timeZone: household?.timeZone ?? null,
    uid: currentUser?.uid ?? '',
    email: currentUser?.email ?? '',
    greetingName: currentUser?.firstName || currentUser?.displayName || null,
    permissions,
  };
}

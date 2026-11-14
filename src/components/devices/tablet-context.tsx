'use client';

// Shared state of the tablet shell (docs/modules/devices/README.md, "Tablet shell").
// Provided by `TabletRuntime` in tablet-shell.tsx; read by the rail, the top bar, the
// views and the dialogs.

import { createContext, useContext } from 'react';
import type { DashboardData } from '@/lib/dashboard/use-dashboard-data';
import type { DeviceCapability, DeviceRefusal, PointsPinPolicy } from '@/lib/devices/action-policy';
import type { QuietHours } from '@/lib/devices/quiet-hours';
import type { RosterPerson } from '@/lib/devices/roster';
import type { ShellState } from '@/lib/devices/shell-state';
import type { SessionEnd } from '@/lib/devices/device-session';
import type { TabletView } from '@/lib/devices/start-page';
import type { DeviceSettings } from '@/lib/devices/types';

export type TabletHousehold = {
  name: string;
  timeZone: string;
  quietHours: QuietHours | null;
  pointsPin: PointsPinPolicy;
};

export type DeviceNotice = {
  id: string;
  category: string;
  title: string;
  message: string;
  createdAt: Date | null;
  deepLink: string | null;
};

/** What an action executor gets: the person and, when unlocked, their PIN session. */
export type TabletActor = { actorUid: string; pinSessionId?: string };

export type TabletActionAnswer = { ok: true } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };

/**
 * A request to do something on the tablet. `execute` is the device server action for the
 * capability (F4 supplies them); without one the tablet refuses at once (every write on a
 * tablet is refused until F4).
 */
export type TabletActionRequest = {
  capability: DeviceCapability;
  label: string;
  execute?: (actor: TabletActor) => Promise<TabletActionAnswer>;
};

export type TabletContextValue = {
  householdId: string;
  deviceId: string;
  generation: number;
  settings: DeviceSettings;
  household: TabletHousehold | null;
  roster: RosterPerson[];
  notices: DeviceNotice[];
  data: DashboardData;
  shell: ShellState;
  view: TabletView;
  /** Goes to a path (deep links into a section that is off land on the start page). */
  navigate: (path: string) => void;
  goStart: () => void;
  /** "Done": forgets the chosen person and ends a PIN unlock. */
  done: () => void;
  runAction: (request: TabletActionRequest) => Promise<void>;
  /**
   * Asks "Who's here?" for an owner or admin (or uses `actorUid`), then a fresh PIN unless
   * that person unlocked in the last 25 s (admin-PIN actions need a session at most 30 s old).
   */
  requestAdmin: (reason: string, actorUid?: string) => Promise<TabletActor | null>;
  idToken: () => Promise<string>;
  endSession: (end: SessionEnd) => void;
  openSettings: () => void;
  openQuickAdd: () => void;
  /** Person by uid from the live roster. */
  person: (uid: string | null | undefined) => RosterPerson | null;
};

export const TabletContext = createContext<TabletContextValue | null>(null);

export function useTablet(): TabletContextValue {
  const value = useContext(TabletContext);
  if (!value) throw new Error('useTablet must be used inside the tablet shell');
  return value;
}

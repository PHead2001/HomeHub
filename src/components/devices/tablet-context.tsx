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

export type { DeviceNotice } from '@/lib/devices/device-session';
import type { DeviceNotice } from '@/lib/devices/device-session';

/** What an action executor gets: the person and, when unlocked, their PIN session. */
export type TabletActor = { actorUid: string; pinSessionId?: string };

export type TabletActionAnswer = { ok: true } | { ok: false; code: DeviceRefusal; retryAfterSec?: number };

/**
 * A request to do something on the tablet. A capability the tablet can send to the server
 * (F4a: chores) goes through the device action runtime with `intent` as its payload
 * (`use-device-actions.tsx`: opId, Undo journal, offline queue). `execute` runs a custom
 * call instead (tablet settings, exits). Anything else is refused at once.
 */
export type TabletActionRequest = {
  capability: DeviceCapability;
  label: string;
  intent?: Record<string, unknown>;
  execute?: (actor: TabletActor) => Promise<TabletActionAnswer>;
  /**
   * Runs if the action is taken back later: its Undo succeeds (also a never-sent queued
   * entry removed on the tablet) or its queued replay is dropped at sync.
   */
  onReverted?: () => void;
};

/**
 * Whether the action went through (false: refused, cancelled or nothing changed).
 * `queued`: saved on this tablet and not applied yet (it syncs when the connection is back).
 */
export type TabletActionOutcome = { ok: boolean; queued?: boolean };

export type TabletContextValue = {
  householdId: string;
  deviceId: string;
  generation: number;
  settings: DeviceSettings;
  household: TabletHousehold | null;
  roster: RosterPerson[];
  notices: DeviceNotice[];
  /** False when a notice source returned its full window (the latest 50): older ones exist on phones. */
  noticesComplete: boolean;
  data: DashboardData;
  shell: ShellState;
  /** "Who's here?" or the PIN pad is open: other dialogs step aside (`settingsLayer`). */
  prompting: boolean;
  view: TabletView;
  /** Goes to a path (deep links into a section that is off land on the start page). */
  navigate: (path: string) => void;
  goStart: () => void;
  /** "Done": forgets the chosen person and ends a PIN unlock. */
  done: () => void;
  runAction: (request: TabletActionRequest) => Promise<TabletActionOutcome>;
  /**
   * Asks "Who's here?" for an owner or admin (or uses `actorUid`), then a fresh PIN unless
   * that person unlocked in the last 25 s (admin-PIN actions need a session at most 30 s old).
   */
  requestAdmin: (reason: string, actorUid?: string) => Promise<TabletActor | null>;
  idToken: () => Promise<string>;
  endSession: (end: SessionEnd) => void;
  /**
   * Runs one of this tablet's protected exits. Session ends signalled while it is in
   * flight wait; on success the session ends as `end` (the exit's own result decides the
   * note), on failure any signal that arrived meanwhile applies.
   */
  runExit: <T extends { ok: boolean }>(end: SessionEnd, call: () => Promise<T>) => Promise<T>;
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

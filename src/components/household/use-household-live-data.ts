'use client';

import { useEffect, useMemo, useState } from 'react';
import { Timestamp, collection, doc, onSnapshot, query, where, type Query, type Unsubscribe } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { inviteDateToIso } from '@/lib/invite-codes';
import type { AuditLog, HouseholdMember, InviteCode } from '@/lib/types';
import { choreStatsByEmail, mergeChoresById, sortMembers, startOfNextWeek, startOfWeek, type ChoreLike, type MemberChoreStats } from './household-model';

type ChoreParts = { key: string; open?: ChoreLike[]; server?: ChoreLike[]; legacy?: ChoreLike[]; failed?: boolean };

export type HouseholdLiveData = {
  /** Live household name (the auth context loads it once). */
  name: string | null;
  members: HouseholdMember[];
  invites: InviteCode[];
  auditLogs: AuditLog[];
  /** Chore counts by lower-cased member email; empty without `chores.view` or until ready. */
  choreStats: Map<string, MemberChoreStats>;
  /** True once every chore listener answered without error; until then show no counts. */
  choreStatsReady: boolean;
  /** True until the first members snapshot (or its error) arrives. */
  loading: boolean;
  /** True when the members listener failed (offline, permission). */
  membersFailed: boolean;
};

type Options = {
  householdId: string | undefined;
  currentMember: HouseholdMember | null;
  canListInvites: boolean;
  canReadAudit: boolean;
  canViewChores: boolean;
};

const byNewest = <T extends { createdAt: string }>(a: T, b: T) =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

/**
 * Live Household Manager data. Each listener is opened only when the caller's
 * role can read that path under the rules, and each fails independently, so a
 * denied invite or audit read never blanks the member list.
 */
export function useHouseholdLiveData({ householdId, currentMember, canListInvites, canReadAudit, canViewChores }: Options): HouseholdLiveData {
  const [name, setName] = useState<string | null>(null);
  const [rawMembers, setRawMembers] = useState<HouseholdMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [weekStart, setWeekStart] = useState(() => startOfWeek());
  // Chore listener results, keyed by household and week so a rollover or a new
  // household never shows the previous week's numbers.
  const choresKey = `${householdId ?? ''}|${weekStart.getTime()}`;
  const [choreParts, setChoreParts] = useState<ChoreParts>({ key: '' });

  // Move the "this week" boundary at local Monday midnight, and re-check when a
  // suspended or hidden tab comes back (timers may not fire while suspended).
  useEffect(() => {
    const sync = () => {
      const current = startOfWeek();
      setWeekStart((prev) => (prev.getTime() === current.getTime() ? prev : current));
    };
    const delay = Math.max(1000, startOfNextWeek().getTime() - Date.now() + 1000);
    const timer = window.setTimeout(sync, Math.min(delay, 2 ** 31 - 1));
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', sync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', sync);
    };
  }, [weekStart]);

  useEffect(() => {
    if (!householdId) return;
    const stops: Unsubscribe[] = [];
    stops.push(onSnapshot(
      doc(db, 'households', householdId),
      (snapshot) => {
        const value = snapshot.data()?.name;
        if (typeof value === 'string') setName(value);
      },
      (error) => console.warn('Household name listener failed', error),
    ));
    stops.push(onSnapshot(
      collection(db, 'households', householdId, 'members'),
      (snapshot) => {
        setRawMembers(snapshot.docs.map((d) => ({ ...d.data(), uid: d.id }) as HouseholdMember));
        setMembersFailed(false);
      },
      (error) => {
        console.error('Failed to load household members', error);
        setMembersFailed(true);
        setRawMembers((prev) => prev ?? []);
      },
    ));
    return () => stops.forEach((stop) => stop());
  }, [householdId]);

  useEffect(() => {
    if (!householdId || !canListInvites) return;
    return onSnapshot(
      query(collection(db, 'inviteCodes'), where('householdId', '==', householdId)),
      (snapshot) => setInvites(snapshot.docs
        .map((d) => ({ ...d.data(), id: d.id, expiresAt: inviteDateToIso(d.data().expiresAt) }) as InviteCode)
        .sort(byNewest)),
      (error) => console.error('Failed to load invite codes', error),
    );
  }, [canListInvites, householdId]);

  useEffect(() => {
    if (!householdId || !canReadAudit) return;
    return onSnapshot(
      collection(db, 'households', householdId, 'auditLogs'),
      (snapshot) => setAuditLogs(snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as AuditLog).sort(byNewest)),
      (error) => console.error('Failed to load audit logs', error),
    );
  }, [canReadAudit, householdId]);

  useEffect(() => {
    if (!householdId || !canViewChores) return;
    // Single-field filters (no composite index): every open chore, plus this week's
    // completions by both timestamps the Chores module reads (`completionInstant`):
    // the server stamp `completedAtServer` (a Timestamp) and the legacy client
    // `completedAt` string. Documents missing a field are not returned by that
    // field's query; the other query covers them. A new `weekStart` re-subscribes all.
    const key = choresKey;
    const choresRef = collection(db, 'households', householdId, 'chores');
    const pick = (id: string, data: Record<string, unknown>): ChoreLike => ({
      id,
      assignedToEmail: typeof data.assignedToEmail === 'string' ? data.assignedToEmail : '',
      isCompleted: data.isCompleted === true,
      completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
      completedAtServer: data.completedAtServer ?? null,
    });
    const listen = (part: 'open' | 'server' | 'legacy', q: Query) => onSnapshot(
      q,
      (snapshot) => setChoreParts((prev) => ({
        ...(prev.key === key ? prev : { key, failed: false }),
        [part]: snapshot.docs.map((d) => pick(d.id, d.data())),
      })),
      (error) => {
        console.warn('Member chore stats unavailable', error);
        setChoreParts((prev) => ({ ...(prev.key === key ? prev : { key }), failed: true }));
      },
    );
    const stops = [
      listen('open', query(choresRef, where('isCompleted', '==', false))),
      listen('server', query(choresRef, where('completedAtServer', '>=', Timestamp.fromDate(weekStart)))),
      listen('legacy', query(choresRef, where('completedAt', '>=', weekStart.toISOString()))),
    ];
    return () => stops.forEach((stop) => stop());
  }, [canViewChores, choresKey, householdId, weekStart]);

  const members = useMemo(() => {
    if (!rawMembers) return [];
    const list = [...rawMembers];
    // Without list access (or before it loads) the caller still sees themselves.
    if (currentMember && !list.some((m) => m.uid === currentMember.uid)) list.push(currentMember);
    return sortMembers(list);
  }, [currentMember, rawMembers]);

  // Stats exist only when all three chore listeners answered for this household and
  // week, and none failed: a failed or pending read is never shown as 0 done / 0 open.
  const parts = choreParts.key === choresKey ? choreParts : { key: choresKey };
  const choreStatsReady = canViewChores && !parts.failed && Boolean(parts.open && parts.server && parts.legacy);
  const choreStats = useMemo(
    () => (choreStatsReady
      ? choreStatsByEmail(mergeChoresById(parts.open!, parts.server!, parts.legacy!), weekStart)
      : new Map<string, MemberChoreStats>()),
    [choreStatsReady, parts.open, parts.server, parts.legacy, weekStart],
  );

  return {
    name,
    members,
    invites: canListInvites ? invites : [],
    auditLogs: canReadAudit ? auditLogs : [],
    choreStats,
    choreStatsReady,
    loading: rawMembers === null,
    membersFailed,
  };
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, where, type Unsubscribe } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { inviteDateToIso } from '@/lib/invite-codes';
import type { AuditLog, Chore, HouseholdMember, InviteCode } from '@/lib/types';
import { choreStatsByEmail, sortMembers, startOfNextWeek, startOfWeek, type MemberChoreStats } from './household-model';

export type HouseholdLiveData = {
  /** Live household name (the auth context loads it once). */
  name: string | null;
  members: HouseholdMember[];
  invites: InviteCode[];
  auditLogs: AuditLog[];
  /** Chore counts by lower-cased member email; empty without `chores.view`. */
  choreStats: Map<string, MemberChoreStats>;
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
  const [chores, setChores] = useState<Pick<Chore, 'assignedToEmail' | 'isCompleted' | 'completedAt'>[]>([]);
  const [weekStart, setWeekStart] = useState(() => startOfWeek());

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
    // Single-field filter (no composite index): every open chore plus this week's completions.
    const choresRef = collection(db, 'households', householdId, 'chores');
    let open: typeof chores = [];
    let done: typeof chores = [];
    const publish = () => setChores([...open, ...done]);
    const pick = (data: Record<string, unknown>) => ({
      assignedToEmail: typeof data.assignedToEmail === 'string' ? data.assignedToEmail : '',
      isCompleted: data.isCompleted === true,
      completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
    });
    const stopOpen = onSnapshot(
      query(choresRef, where('isCompleted', '==', false)),
      (snapshot) => { open = snapshot.docs.map((d) => pick(d.data())); publish(); },
      (error) => console.warn('Member chore stats unavailable', error),
    );
    const stopDone = onSnapshot(
      query(choresRef, where('completedAt', '>=', weekStart.toISOString())),
      (snapshot) => { done = snapshot.docs.map((d) => pick(d.data())).filter((c) => c.isCompleted); publish(); },
      (error) => console.warn('Member chore stats unavailable', error),
    );
    return () => { stopOpen(); stopDone(); };
  }, [canViewChores, householdId, weekStart]);

  const members = useMemo(() => {
    if (!rawMembers) return [];
    const list = [...rawMembers];
    // Without list access (or before it loads) the caller still sees themselves.
    if (currentMember && !list.some((m) => m.uid === currentMember.uid)) list.push(currentMember);
    return sortMembers(list);
  }, [currentMember, rawMembers]);

  // Data from a listener that is no longer allowed (role changed) is not shown.
  const choreStats = useMemo(
    () => (canViewChores ? choreStatsByEmail(chores, weekStart) : new Map<string, MemberChoreStats>()),
    [canViewChores, chores, weekStart],
  );

  return {
    name,
    members,
    invites: canListInvites ? invites : [],
    auditLogs: canReadAudit ? auditLogs : [],
    choreStats,
    loading: rawMembers === null,
    membersFailed,
  };
}

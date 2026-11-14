'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { auth } from '@/lib/firebase-app';
import { useToast } from '@/hooks/use-toast';
import { rank } from '@/lib/household-policy';
import type { HouseholdMember } from '@/lib/types';
import {
  clearChildPinAction,
  clearMemberPinAction,
  clearPinLockoutAction,
  pinStatusAction,
  setChildPinAction,
} from '@/app/household/pin-actions';
import { createChildIdentityAction, updateChildIdentityAction } from '@/app/household/child-actions';
import { KidPinDialog, KidProfileDialog, uploadKidPhoto, type KidProfileSave } from './child-identity-dialog';
import { saveKidProfile } from './kid-profile-save';

// Members-tab controls for wall tablets (docs/modules/devices/README.md, "Actors" and
// "PINs"): kid profiles (add, edit, set or clear their PIN, remove) and, for account
// members of a lower role, clearing or unlocking their tablet PIN. Removing a kid profile
// is the card's usual Remove (the server routes it to the kid-profile removal). Owners and admins
// (role) only, and only with the wall-tablet flag on. The server checks everything again.

const devicesEnabled = process.env.NEXT_PUBLIC_HOMEHUB_DEVICES === 'true';

export type MemberTabletAction = 'edit-kid' | 'set-kid-pin' | 'clear-pin' | 'unlock-pin';

/** What the viewer may do about one member's tablet PIN or kid profile. */
export type MemberTabletActions = {
  isKid: boolean;
  hasPin: boolean;
  locked: boolean;
  actions: MemberTabletAction[];
};

type Result = { ok: true; data: unknown } | { ok: false; message: string };

export function useMemberTabletControls({ householdId, currentMember, members }: {
  householdId: string | null | undefined;
  currentMember: HouseholdMember | null | undefined;
  members: HouseholdMember[];
}): {
  enabled: boolean;
  actionsFor: (member: HouseholdMember) => MemberTabletActions | undefined;
  run: (member: HouseholdMember, action: MemberTabletAction) => void;
  openCreateKid: () => void;
  dialogs: ReactNode;
} {
  const { toast, toastError } = useToast();
  const enabled = devicesEnabled && Boolean(householdId) && Boolean(currentMember) &&
    (currentMember!.status ?? 'active') === 'active' && (currentMember!.role === 'owner' || currentMember!.role === 'admin');
  const [statuses, setStatuses] = useState<Record<string, { hasPin: boolean; locked: boolean }>>({});
  const [kidDialog, setKidDialog] = useState<{ open: boolean; child: HouseholdMember | null; seq: number; createdId: string | null }>({ open: false, child: null, seq: 0, createdId: null });
  const [pinDialog, setPinDialog] = useState<{ open: boolean; child: HouseholdMember | null; seq: number }>({ open: false, child: null, seq: 0 });

  // Refreshed whenever the member list changes (a new kid profile, someone removed).
  const memberKey = useMemo(() => members.map(m => `${m.uid}:${m.role}`).sort().join('|'), [members]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => {
    if (!enabled || !householdId) return;
    let cancelled = false;
    void (async () => {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const result = await pinStatusAction({ idToken: await user.getIdToken(), householdId });
        if (!cancelled && result.ok) setStatuses(result.data);
      } catch {
        // The menu simply offers fewer PIN actions until the next refresh.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, householdId, memberKey, tick]);

  const call = useCallback(async (failTitle: string, work: (idToken: string, householdId: string) => Promise<Result>): Promise<boolean> => {
    if (!householdId || !auth.currentUser) return false;
    try {
      const result = await work(await auth.currentUser.getIdToken(), householdId);
      if (!result.ok) {
        toast({ variant: 'destructive', title: failTitle, description: result.message });
        return false;
      }
      return true;
    } catch (error) {
      toastError(error, failTitle);
      return false;
    }
  }, [householdId, toast, toastError]);

  const actionsFor = useCallback((member: HouseholdMember): MemberTabletActions | undefined => {
    if (!enabled || !currentMember || member.role === 'newuser' || (member.status ?? 'active') !== 'active') return undefined;
    const isKid = member.kind === 'identity';
    const status = statuses[member.uid] ?? { hasPin: false, locked: false };
    const outranks = member.uid !== currentMember.uid && rank(currentMember.role) > rank(member.role);
    const actions: MemberTabletAction[] = [];
    if (isKid) {
      actions.push('edit-kid', 'set-kid-pin');
      if (status.hasPin) actions.push('clear-pin');
      if (status.locked) actions.push('unlock-pin');
    } else if (outranks) {
      if (status.hasPin) actions.push('clear-pin');
      if (status.locked) actions.push('unlock-pin');
    }
    return { isKid, hasPin: status.hasPin, locked: status.locked, actions };
  }, [currentMember, enabled, statuses]);

  const name = (member: HouseholdMember) => member.displayName?.trim() || 'Member';

  const run = useCallback((member: HouseholdMember, action: MemberTabletAction) => {
    void (async () => {
      if (action === 'edit-kid') return setKidDialog(current => ({ open: true, child: member, seq: current.seq + 1, createdId: null }));
      if (action === 'set-kid-pin') return setPinDialog(current => ({ open: true, child: member, seq: current.seq + 1 }));
      if (action === 'clear-pin') {
        const ok = await call(`Couldn't clear ${name(member)}'s PIN`, (idToken, householdId) => member.kind === 'identity'
          ? clearChildPinAction({ idToken, householdId, childId: member.uid })
          : clearMemberPinAction({ idToken, householdId, targetUid: member.uid }));
        if (ok) toast({ title: 'Tablet PIN cleared', description: member.kind === 'identity' ? `${name(member)} has no PIN now.` : `${name(member)} can set a new one from their phone.` });
      } else if (action === 'unlock-pin') {
        const ok = await call(`Couldn't unlock ${name(member)}'s PIN`, (idToken, householdId) =>
          clearPinLockoutAction({ idToken, householdId, targetUid: member.uid }));
        if (ok) toast({ title: 'Tablet PIN unlocked', description: `${name(member)} can use their PIN again.` });
      }
      refresh();
    })();
  }, [call, refresh, toast]);

  const saveKid: KidProfileSave = async ({ name: kidName, photo, removePhoto }) => {
    const editing = Boolean(kidDialog.child);
    const result = await saveKidProfile({
      create: async (kidNameToCreate) => {
        let created: string | null = null;
        const ok = await call("Couldn't add the kid profile", async (idToken, householdId) => {
          const outcome = await createChildIdentityAction({ idToken, householdId, name: kidNameToCreate });
          if (outcome.ok) created = outcome.data.childId;
          return outcome;
        });
        return ok && created ? { ok: true, childId: created } : { ok: false };
      },
      upload: async (childId, file) => {
        if (!householdId) return null;
        try {
          return await uploadKidPhoto(householdId, childId, file);
        } catch (error) {
          toastError(error, "Couldn't upload the photo");
          return null;
        }
      },
      update: (childId, patch) => call("Couldn't save the kid profile", (idToken, householdId) =>
        updateChildIdentityAction({ idToken, householdId, childId, ...patch })),
    }, { existingId: kidDialog.child?.uid ?? kidDialog.createdId }, { name: kidName, photo, removePhoto });
    // Remember a profile created by this dialog, so pressing Save again updates it.
    if (result.childId && !kidDialog.child) setKidDialog(current => ({ ...current, createdId: result.childId }));
    if (!result.ok) return false;
    toast({ title: editing ? 'Kid profile saved' : 'Kid profile added', description: editing ? undefined : `${kidName} now appears on wall tablets.` });
    refresh();
    return true;
  };

  const savePin = async (pin: string) => {
    const child = pinDialog.child;
    if (!child) return false;
    const ok = await call(`Couldn't save ${name(child)}'s PIN`, (idToken, householdId) =>
      setChildPinAction({ idToken, householdId, childId: child.uid, pin }));
    if (ok) {
      toast({ title: 'Tablet PIN saved', description: `${name(child)} can use it on wall tablets now.` });
      refresh();
    }
    return ok;
  };

  const dialogs = enabled ? (
    <>
      <KidProfileDialog key={`kid-${kidDialog.seq}`} open={kidDialog.open} child={kidDialog.child} onOpenChange={(open) => setKidDialog((current) => ({ ...current, open }))} onSave={saveKid} />
      <KidPinDialog key={`pin-${pinDialog.seq}`} open={pinDialog.open} child={pinDialog.child} onOpenChange={(open) => setPinDialog((current) => ({ ...current, open }))} onSave={savePin} />
    </>
  ) : null;

  return { enabled, actionsFor, run, openCreateKid: () => setKidDialog(current => ({ open: true, child: null, seq: current.seq + 1, createdId: null })), dialogs };
}

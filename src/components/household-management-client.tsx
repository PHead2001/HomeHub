'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence } from 'motion/react';
import {
  arrayRemove,
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { AlertTriangle, Copy, Home, Loader2, LogOut, Shield, UserPlus, Users } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { buildNotificationDocument, getDeterministicNotificationId } from '@/lib/notifications';
import {
  assignableRoles,
  canChangeRole,
  canManageMember,
  canRemoveMember,
  canTransferOwnership,
  hasPermission,
} from '@/lib/permissions';
import { memberColorMap } from '@/lib/member-colors';
import type { HouseholdMember, HouseholdRole, InviteCode, PermissionOverrides } from '@/lib/types';
import { EmptyState } from '@/components/empty-state';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MemberAvatarStack } from '@/components/member-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { copyText } from '@/lib/utils';
import { inviteDateToIso } from '@/lib/invite-codes';
import { ConfirmActionDialog, type ConfirmRequest } from '@/components/household/confirm-action-dialog';
import {
  HOUSEHOLD_NAME_MAX,
  INVITE_STATE_LABELS,
  describeAuditAction,
  householdNameError,
  inviteState,
  isActiveInvite,
  memberName,
  relativeTime,
  roleLabel,
} from '@/components/household/household-model';
import { MemberCard, type MemberActions } from '@/components/household/member-card';
import { PendingMemberBanner } from '@/components/household/pending-member-banner';
import { ALL_ROLES, RolesPanel } from '@/components/household/roles-panel';
import { useHouseholdLiveData } from '@/components/household/use-household-live-data';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MINUTES = 30;
const NEW_USER_REMINDER_HOURS = 24;

const generateSegment = (length: number) => {
  const bytes = new Uint32Array(length);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * INVITE_CHARS.length);
  }
  return Array.from(bytes, value => INVITE_CHARS[value % INVITE_CHARS.length]).join('');
};

const generateInviteCode = () => `${generateSegment(4)}-${generateSegment(4)}-${generateSegment(2)}`;

const householdTabs = ['overview', 'invites', 'members', 'roles', 'activity', 'danger'];

export function HouseholdManagementClient() {
  const { currentUser, household, currentMember, permissions, leaveHousehold, deleteHousehold } = useAuth();
  const { toast, toastError } = useToast();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');

  const canManageMembers = permissions['household.manageMembers'];
  const canManageInvites = permissions['household.manageInvites'];
  const canManageRoles = permissions['household.manageRoles'];
  const isOwner = currentMember?.role === 'owner';
  // Audit entries are readable by owners and admins only (firestore.rules).
  const canReadAudit = currentMember?.role === 'owner' || currentMember?.role === 'admin';

  const visibleTabs = useMemo(
    () => householdTabs.filter((tab) => (tab === 'invites' ? canManageInvites : tab === 'activity' ? canReadAudit : true)),
    [canManageInvites, canReadAudit],
  );
  const [activeTab, setActiveTab] = useState(() =>
    requestedTab && householdTabs.includes(requestedTab) ? requestedTab : 'overview');
  // A notification link to ?tab=… while this page is already open changes the URL without
  // remounting; follow it. Manual tab clicks are not overridden until the URL changes again.
  useEffect(() => {
    if (requestedTab && householdTabs.includes(requestedTab)) setActiveTab(requestedTab);
  }, [requestedTab]);
  const shownTab = visibleTabs.includes(activeTab) ? activeTab : 'overview';

  const live = useHouseholdLiveData({
    householdId: household?.id,
    currentMember,
    canListInvites: Boolean(canManageInvites),
    canReadAudit,
    canViewChores: Boolean(permissions['chores.view']),
  });
  const { members, invites, auditLogs, choreStats } = live;
  const householdDisplayName = live.name ?? household?.name ?? '';

  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  // The rename field follows the live name until someone edits it.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const nameTouched = nameDraft !== null;
  const householdName = nameDraft ?? householdDisplayName;
  const [nameSubmitted, setNameSubmitted] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [matrixSelection, setMatrixSelection] = useState<string>(ALL_ROLES);

  const activeInvites = useMemo(() => invites.filter((invite) => isActiveInvite(invite)), [invites]);
  const pendingMembers = useMemo(() => members.filter(member => member.role === 'newuser'), [members]);
  const approvedMembers = useMemo(() => members.filter(member => member.role !== 'newuser'), [members]);
  const colors = useMemo(() => memberColorMap(members.map((m) => m.uid)), [members]);

  // Daily "still pending" reminder, written by whichever manager opens this page.
  const remindingRef = useRef(false);
  useEffect(() => {
    const remindPendingMembers = async () => {
      if (!household?.id || !canManageMembers || pendingMembers.length === 0 || remindingRef.current) return;
      const now = new Date();
      const batch = writeBatch(db);
      let reminderCount = 0;

      pendingMembers.forEach((member) => {
        const lastReminder = member.lastNewUserReminderAt ? new Date(member.lastNewUserReminderAt) : null;
        const reminderAgeHours = lastReminder
          ? (now.getTime() - lastReminder.getTime()) / (1000 * 60 * 60)
          : Number.POSITIVE_INFINITY;
        if (reminderAgeHours < NEW_USER_REMINDER_HOURS) return;

        const nowIso = now.toISOString();
        const reminderStateKey = `pending|${nowIso.slice(0, 10)}`;
        const reminderNotificationId = getDeterministicNotificationId({
          sourceType: 'household-newuser-reminder',
          sourceId: member.uid,
          stateKey: reminderStateKey,
        });
        batch.update(doc(db, 'households', household.id, 'members', member.uid), {
          lastNewUserReminderAt: nowIso,
        });
        batch.set(doc(db, 'households', household.id, 'notifications', reminderNotificationId), buildNotificationDocument({
          householdId: household.id,
          category: 'system',
          title: 'Pending member approval',
          message: `${member.displayName || member.email} still needs a household role.`,
          deepLink: '/household?tab=members',
          sourceType: 'household-newuser-reminder',
          sourceId: member.uid,
          stateKey: reminderStateKey,
        }));
        reminderCount++;
      });

      if (reminderCount > 0) {
        remindingRef.current = true;
        try {
          await batch.commit();
        } finally {
          remindingRef.current = false;
        }
      }
    };

    remindPendingMembers().catch((error) => {
      console.error('Failed to create pending member reminders', error);
    });
  }, [canManageMembers, household?.id, pendingMembers]);

  const nameError = householdNameError(householdName);
  const showNameError = nameSubmitted && nameError;

  const saveHouseholdName = async () => {
    setNameSubmitted(true);
    if (!household?.id || nameError || !canManageMembers) return;
    setIsSavingName(true);
    try {
      await updateDoc(doc(db, 'households', household.id), {
        name: householdName.trim(),
        updatedAt: new Date().toISOString(),
      });
      setNameDraft(null);
      setNameSubmitted(false);
      toast({ title: 'Household renamed', description: `It's now called ${householdName.trim()}.` });
    } catch (error) {
      console.error('Failed to update household name', error);
      toastError(error, 'Could not rename the household');
    } finally {
      setIsSavingName(false);
    }
  };

  const generateInvite = async () => {
    if (!household?.id || !currentUser?.email || !canManageInvites) return;
    setIsGeneratingInvite(true);
    try {
      let createdInviteCode: string | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = generateInviteCode();
        const inviteRef = doc(db, 'inviteCodes', code);
        try {
          await runTransaction(db, async (transaction) => {
            const existing = await transaction.get(inviteRef);
            if (existing.exists() && isActiveInvite({ id: existing.id, ...existing.data(), expiresAt: inviteDateToIso(existing.data().expiresAt) } as InviteCode)) {
              throw new Error('Invite code collision.');
            }
            const now = new Date();
            const expiresAt = new Date(now.getTime() + INVITE_TTL_MINUTES * 60 * 1000);
            const createdInvite: InviteCode = {
              id: code,
              code,
              householdId: household.id,
              householdName: householdDisplayName || household.name,
              createdByUid: currentUser.uid,
              createdByEmail: currentUser.email,
              createdAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
              maxUses: 1,
              useCount: 0,
            };
            // Rules require a real Timestamp expiry no more than two hours ahead.
            transaction.set(inviteRef, { ...createdInvite, expiresAt: Timestamp.fromDate(expiresAt) });
            transaction.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
              actorUid: currentUser.uid,
              actorEmail: currentUser.email,
              actorName: currentUser.displayName,
              action: 'invite.generated',
              createdAt: now.toISOString(),
              details: { code },
            });
          });
          createdInviteCode = code;
          break;
        } catch (error) {
          if (attempt === 5) throw error;
        }
      }

      if (!createdInviteCode) throw new Error('Could not generate a unique invite code.');
      // The code exists now; copying is a convenience that must not turn a successful
      // invite into a reported failure (iOS often blocks clipboard writes after an await).
      const copied = await copyText(createdInviteCode);
      toast({
        title: 'Invite code ready',
        description: copied
          ? `${createdInviteCode} is copied. Share it within ${INVITE_TTL_MINUTES} minutes.`
          : `Share ${createdInviteCode} within ${INVITE_TTL_MINUTES} minutes. It is also listed below.`,
      });
    } catch (error) {
      console.error('Failed to generate invite', error);
      toastError(error, 'Could not create an invite code');
    } finally {
      setIsGeneratingInvite(false);
    }
  };

  const revokeInvite = async (invite: InviteCode) => {
    if (!household?.id || !currentUser?.email || !canManageInvites) return;
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      batch.update(doc(db, 'inviteCodes', invite.id), { revokedAt: now });
      batch.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'invite.revoked',
        createdAt: now,
        details: { code: invite.code },
      });
      await batch.commit();
      toast({ title: 'Invite revoked', description: `${invite.code} can no longer be used.` });
    } catch (error) {
      console.error('Failed to revoke invite', error);
      toastError(error, 'Could not revoke the invite');
    }
  };

  const revokeAllInvites = async () => {
    if (!household?.id || !currentUser?.email || !canManageInvites || activeInvites.length === 0) return;
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      activeInvites.forEach(invite => batch.update(doc(db, 'inviteCodes', invite.id), { revokedAt: now }));
      batch.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'invite.revoked_all',
        createdAt: now,
        details: { count: activeInvites.length },
      });
      await batch.commit();
      toast({ title: 'Invites revoked', description: 'Every active invite code was revoked.' });
    } catch (error) {
      console.error('Failed to revoke active invites', error);
      toastError(error, 'Could not revoke the invites');
    }
  };

  const changeMemberRole = async (member: HouseholdMember, nextRole: HouseholdRole) => {
    if (!household?.id || !currentUser?.email || !currentMember || !canChangeRole(currentMember, member, nextRole)) return;
    const approving = member.role === 'newuser';
    try {
      const now = new Date().toISOString();
      const nextStatus = nextRole === 'newuser' ? 'pending' : 'active';
      const batch = writeBatch(db);
      batch.update(doc(db, 'households', household.id, 'members', member.uid), {
        role: nextRole,
        status: nextStatus,
        permissions: {},
        approvedAt: nextRole === 'newuser' ? null : now,
        approvedByUid: nextRole === 'newuser' ? null : currentUser.uid,
      });
      batch.set(doc(db, 'users', member.email), {
        role: nextRole,
        permissions: {},
      }, { merge: true });
      batch.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'member.role_changed',
        targetUid: member.uid,
        targetEmail: member.email,
        targetName: member.displayName,
        createdAt: now,
        details: { role: nextRole },
      });
      await batch.commit();
      toast(approving
        ? { title: `${memberName(member)} is in`, description: `They joined as ${roleLabel(nextRole)}.` }
        : { title: 'Role updated', description: `${memberName(member)} is now ${roleLabel(nextRole)}.` });
    } catch (error) {
      console.error('Failed to change member role', error);
      toastError(error, approving ? 'Could not approve' : 'Could not change the role');
    }
  };

  const saveMemberPermissions = async (member: HouseholdMember, overrides: PermissionOverrides) => {
    if (!household?.id || !currentUser?.email || !currentMember) return false;
    if (!canManageMember(currentMember, member) || member.role === 'owner') return false;
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      batch.update(doc(db, 'households', household.id, 'members', member.uid), {
        permissions: overrides,
      });
      batch.set(doc(db, 'users', member.email), {
        permissions: overrides,
      }, { merge: true });
      batch.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'member.permissions_changed',
        targetUid: member.uid,
        targetEmail: member.email,
        targetName: member.displayName,
        createdAt: now,
      });
      await batch.commit();
      toast({ title: 'Permissions saved', description: `${memberName(member)}'s permissions were updated.` });
      return true;
    } catch (error) {
      console.error('Failed to save permissions', error);
      toastError(error, 'Could not save permissions');
      return false;
    }
  };

  const removeMember = async (member: HouseholdMember, denied = false) => {
    if (!household?.id || !currentUser?.email || !currentMember || !canRemoveMember(currentMember, member)) return;
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      batch.delete(doc(db, 'households', household.id, 'members', member.uid));
      batch.update(doc(db, 'households', household.id), {
        memberEmails: arrayRemove(member.email),
        updatedAt: now,
      });
      batch.set(doc(db, 'users', member.email), {
        householdId: null,
        role: 'member',
        permissions: {},
      }, { merge: true });
      batch.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'member.removed',
        targetUid: member.uid,
        targetEmail: member.email,
        targetName: member.displayName,
        createdAt: now,
      });

      const choresSnap = await getDocs(query(
        collection(db, 'households', household.id, 'chores'),
        where('assignedToEmail', '==', member.email)
      ));
      choresSnap.forEach(choreDoc => batch.update(choreDoc.ref, {
        assignedToEmail: '',
        assignedToDisplayName: 'Unassigned',
      }));

      const templatesSnap = await getDocs(query(
        collection(db, 'households', household.id, 'chore-templates'),
        where('assignedToEmail', '==', member.email)
      ));
      templatesSnap.forEach(templateDoc => batch.update(templateDoc.ref, {
        assignedToEmail: null,
      }));

      await batch.commit();
      toast(denied
        ? { title: 'Request denied', description: `${memberName(member)} was not added to the household.` }
        : { title: 'Member removed', description: `${memberName(member)} was removed from the household.` });
    } catch (error) {
      console.error('Failed to remove member', error);
      toastError(error, denied ? 'Could not deny the request' : 'Could not remove the member');
    }
  };

  const transferOwnership = async (member: HouseholdMember) => {
    if (!household?.id || !currentUser?.email || !currentMember || !canTransferOwnership(currentMember, member)) return;
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      batch.update(doc(db, 'households', household.id), {
        ownerEmail: member.email,
        ownerUid: member.uid,
        updatedAt: now,
      });
      batch.update(doc(db, 'households', household.id, 'members', member.uid), {
        role: 'owner',
        status: 'active',
        permissions: {},
      });
      batch.update(doc(db, 'households', household.id, 'members', currentMember.uid), {
        role: 'admin',
        status: 'active',
        permissions: {},
      });
      batch.set(doc(db, 'users', member.email), { role: 'owner', permissions: {} }, { merge: true });
      batch.set(doc(db, 'users', currentUser.email), { role: 'admin', permissions: {} }, { merge: true });
      batch.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'ownership.transferred',
        targetUid: member.uid,
        targetEmail: member.email,
        targetName: member.displayName,
        createdAt: now,
      });
      batch.set(doc(collection(db, 'households', household.id, 'notifications')), buildNotificationDocument({
        householdId: household.id,
        category: 'system',
        title: 'Household ownership transferred',
        message: `${member.displayName || member.email} is now the owner of ${householdDisplayName || household.name}.`,
        deepLink: '/household',
        sourceType: 'household-ownership-transfer',
        sourceId: member.uid,
      }));
      await batch.commit();
      toast({ title: 'Ownership transferred', description: `${memberName(member)} is now the household owner.` });
    } catch (error) {
      console.error('Failed to transfer ownership', error);
      toastError(error, 'Could not transfer ownership');
    }
  };

  /** What the viewer may do to a member; the card shows nothing else. */
  const actionsFor = (member: HouseholdMember): MemberActions => {
    const actor = currentMember;
    const manageable = Boolean(actor && canManageMember(actor, member));
    return {
      roles: actor && canManageRoles && manageable && member.role !== 'owner'
        ? assignableRoles.filter((role) => canChangeRole(actor, member, role))
        : [],
      canCustomize: manageable && member.role !== 'owner' && member.role !== 'newuser',
      canTransfer: Boolean(actor && canTransferOwnership(actor, member)),
      canRemove: Boolean(actor && canRemoveMember(actor, member)),
    };
  };

  const askRemove = (member: HouseholdMember) => setConfirm({
    title: `Remove ${memberName(member)}?`,
    description: `They lose access to ${householdDisplayName} right away. Chores assigned to them become unassigned.`,
    confirmLabel: 'Remove',
    destructive: true,
    onConfirm: () => removeMember(member),
  });

  const askDeny = (member: HouseholdMember) => setConfirm({
    title: `Deny ${memberName(member)}?`,
    description: `Their request to join ${householdDisplayName} is removed. They can ask again with a new invite code.`,
    confirmLabel: 'Deny request',
    destructive: true,
    onConfirm: () => removeMember(member, true),
  });

  const askTransfer = (member: HouseholdMember) => setConfirm({
    title: `Make ${memberName(member)} the owner?`,
    description: 'They get full control, including deleting the household. You become an admin.',
    confirmLabel: 'Transfer ownership',
    onConfirm: () => transferOwnership(member),
  });

  const askLeave = () => setConfirm({
    title: `Leave ${householdDisplayName}?`,
    description: 'You lose access right away. Chores assigned to you become unassigned. You can rejoin with a new invite code.',
    confirmLabel: 'Leave household',
    destructive: true,
    onConfirm: () => leaveHousehold(),
  });

  const openCustomize = (member: HouseholdMember) => {
    setMatrixSelection(member.uid);
    setActiveTab('roles');
  };

  if (!currentUser) {
    return <SignInPrompt what="manage your household" />;
  }

  if (!household) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No household yet</CardTitle>
          <CardDescription>Create or join a household before managing household settings.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!hasPermission(currentMember?.role, 'household.view', currentMember?.permissions)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Waiting for approval</CardTitle>
          <CardDescription>An owner or admin needs to choose your role before you can see household settings.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/profile">Open Profile</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const memberStatValue = pendingMembers.length > 0
    ? `${approvedMembers.length} · ${pendingMembers.length} pending`
    : String(approvedMembers.length);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="font-headline text-3xl font-bold">Manage Household</h1>
        <p className="text-muted-foreground">Members, roles, invite codes, and household controls.</p>
      </div>

      {live.loading ? (
        <div role="status" aria-label="Loading household" className="space-y-4">
          <Skeleton className="h-10 w-full rounded-lg" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
            {[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-20 rounded-lg" />)}
          </div>
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      ) : (
        <Tabs value={shownTab} onValueChange={setActiveTab}>
          <TabsList className="grid h-auto w-full grid-cols-3 md:flex md:w-auto md:justify-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {canManageInvites && <TabsTrigger value="invites">Invite Codes</TabsTrigger>}
            <TabsTrigger value="members" className="gap-1.5">
              Members
              {pendingMembers.length > 0 && canManageMembers && (
                <span className="rounded-full bg-warning px-1.5 text-xs font-semibold text-warning-foreground" aria-label={`${pendingMembers.length} pending`}>
                  {pendingMembers.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            {canReadAudit && <TabsTrigger value="activity">Activity</TabsTrigger>}
            <TabsTrigger value="danger">Danger Zone</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4 pt-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
              <SummaryCard icon={Home} label="Household" value={householdDisplayName} />
              <SummaryCard
                icon={Users}
                label="Members"
                value={memberStatValue}
                extra={approvedMembers.length > 1 ? (
                  <MemberAvatarStack
                    members={approvedMembers.map((m) => ({ uid: m.uid, name: memberName(m), photoUrl: m.avatarUrl }))}
                    size="sm"
                    max={4}
                    className="mt-1"
                  />
                ) : null}
              />
              <SummaryCard icon={Shield} label="Your role" value={currentMember ? roleLabel(currentMember.role) : 'Member'} />
              <SummaryCard icon={UserPlus} label="Active invites" value={String(activeInvites.length)} />
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Household name</CardTitle>
                <CardDescription>Everyone in the household sees this name. Changing it never changes your invite codes or data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {canManageMembers ? (
                  <form
                    noValidate
                    className="grid gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveHouseholdName();
                    }}
                  >
                    <Label htmlFor="household-name">Display name</Label>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <div className="grid flex-1 gap-1.5">
                        <Input
                          {...fieldErrorProps('household-name', showNameError)}
                          value={householdName}
                          maxLength={HOUSEHOLD_NAME_MAX}
                          autoComplete="off"
                          onChange={(event) => setNameDraft(event.target.value)}
                        />
                        <FieldError id="household-name">{showNameError}</FieldError>
                      </div>
                      <Button type="submit" disabled={isSavingName || (!nameTouched && !nameSubmitted)}>
                        {isSavingName && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="break-words font-semibold">{householdDisplayName}</p>
                )}
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <span>Household ID (used by support; you never need to type it)</span>
                  <span className="break-all font-code">{household.id}</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {canManageInvites && (
            <TabsContent value="invites" className="space-y-4 pt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Invite codes</CardTitle>
                  <CardDescription>Codes last {INVITE_TTL_MINUTES} minutes and work once. New people wait for you to choose their role before they see anything.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {invites.length > 0 && (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button onClick={generateInvite} disabled={isGeneratingInvite}>
                        {isGeneratingInvite ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
                        Create invite code
                      </Button>
                      {activeInvites.length > 0 && (
                        <Button variant="outline" onClick={revokeAllInvites}>
                          Revoke active codes
                        </Button>
                      )}
                    </div>
                  )}
                  {invites.length === 0 ? (
                    <EmptyState
                      kind="generic"
                      headingLevel={3}
                      title="No invite codes yet"
                      description="Create a code and share it with someone you live with. It works once and lasts 30 minutes."
                      action={{ label: isGeneratingInvite ? 'Creating…' : 'Create invite code', icon: <UserPlus className="mr-2 h-4 w-4" />, onClick: () => { if (!isGeneratingInvite) void generateInvite(); } }}
                    />
                  ) : (
                    <ul className="grid gap-3">
                      {invites.map(invite => {
                        const state = inviteState(invite);
                        const active = state === 'active';
                        return (
                          <li key={invite.id} className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-code text-lg font-semibold tracking-wider">{invite.code}</span>
                                <Badge variant={active ? 'default' : 'secondary'}>{INVITE_STATE_LABELS[state]}</Badge>
                              </div>
                              <p className="break-words text-sm text-muted-foreground">
                                Created by {invite.createdByEmail}
                                {active ? ` · expires ${relativeTime(invite.expiresAt)}` : ` · ${relativeTime(invite.createdAt)}`}
                              </p>
                            </div>
                            {active && (
                              <div className="flex gap-2">
                                <Button variant="outline" size="icon" aria-label={`Copy invite code ${invite.code}`} onClick={async () => {
                                  const copied = await copyText(invite.code);
                                  toast(copied ? { title: 'Copied', description: invite.code } : { title: 'Copy not available', description: `Share ${invite.code} manually.` });
                                }}>
                                  <Copy className="h-4 w-4" />
                                </Button>
                                <Button variant="outline" onClick={() => revokeInvite(invite)} aria-label={`Revoke invite code ${invite.code}`}>
                                  Revoke
                                </Button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          <TabsContent value="members" className="space-y-4 pt-4">
            {live.membersFailed && (
              <p role="status" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
                We couldn&apos;t load everyone right now. Check your connection; this list updates on its own.
              </p>
            )}
            {canManageMembers && (
              <AnimatePresence initial={false}>
                {pendingMembers.map((member) => {
                  const actions = actionsFor(member);
                  if (actions.roles.length === 0 && !actions.canRemove) return null;
                  return (
                    <PendingMemberBanner
                      key={member.uid}
                      member={member}
                      color={colors.get(member.uid)!}
                      roles={actions.roles}
                      canDeny={actions.canRemove}
                      onApprove={changeMemberRole}
                      onDeny={askDeny}
                    />
                  );
                })}
              </AnimatePresence>
            )}
            {approvedMembers.length <= 1 && pendingMembers.length === 0 ? (
              <>
                {approvedMembers.map((member) => (
                  <MemberCard
                    key={member.uid}
                    member={member}
                    color={colors.get(member.uid)!}
                    isSelf={member.uid === currentMember?.uid}
                    stats={choreStats.get(member.email.toLowerCase()) ?? (permissions['chores.view'] ? { doneThisWeek: 0, open: 0 } : undefined)}
                    actions={actionsFor(member)}
                    onRoleChange={changeMemberRole}
                    onCustomize={openCustomize}
                    onTransfer={askTransfer}
                    onRemove={askRemove}
                  />
                ))}
                <Card>
                  <EmptyState
                    kind="generic"
                    headingLevel={3}
                    title="It's just you so far"
                    description="Invite the people you live with so chores, lists and pets can be shared."
                    action={canManageInvites ? { label: 'Create an invite code', icon: <UserPlus className="mr-2 h-4 w-4" />, onClick: () => setActiveTab('invites') } : undefined}
                  />
                </Card>
              </>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {(canManageMembers ? approvedMembers : members).map((member) => (
                  <MemberCard
                    key={member.uid}
                    member={member}
                    color={colors.get(member.uid)!}
                    isSelf={member.uid === currentMember?.uid}
                    stats={member.role === 'newuser' ? undefined : choreStats.get(member.email.toLowerCase()) ?? (permissions['chores.view'] ? { doneThisWeek: 0, open: 0 } : undefined)}
                    actions={actionsFor(member)}
                    onRoleChange={changeMemberRole}
                    onCustomize={openCustomize}
                    onTransfer={askTransfer}
                    onRemove={askRemove}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="roles" className="space-y-4 pt-4">
            <RolesPanel
              members={members}
              colors={colors}
              viewerRole={currentMember?.role}
              selected={matrixSelection}
              onSelect={setMatrixSelection}
              canEdit={(member) => Boolean(currentMember && canManageMember(currentMember, member))}
              onSave={saveMemberPermissions}
            />
          </TabsContent>

          {canReadAudit && (
            <TabsContent value="activity" className="space-y-4 pt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Activity</CardTitle>
                  <CardDescription>Who changed what in the household, newest first.</CardDescription>
                </CardHeader>
                <CardContent>
                  {auditLogs.length === 0 ? (
                    <EmptyState
                      compact
                      headingLevel={3}
                      title="Nothing yet"
                      description="Invites, approvals and role changes will show up here."
                    />
                  ) : (
                    <ol className="space-y-2">
                      {auditLogs.slice(0, 50).map(log => {
                        const actor = log.actorName || log.actorEmail || 'HomeHub';
                        const target = log.targetName || log.targetEmail;
                        return (
                          <li key={log.id} className="rounded-md border border-border-subtle p-3">
                            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                              <p className="font-medium">{describeAuditAction(log)}</p>
                              <time dateTime={log.createdAt} title={new Date(log.createdAt).toLocaleString()} className="text-xs text-muted-foreground">
                                {relativeTime(log.createdAt)}
                              </time>
                            </div>
                            <p className="break-words text-sm text-muted-foreground">
                              {actor}{target && target !== actor ? ` → ${target}` : ''}
                            </p>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          <TabsContent value="danger" className="space-y-4 pt-4">
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive"><AlertTriangle aria-hidden /> Danger Zone</CardTitle>
                <CardDescription>Leaving or deleting can&apos;t be undone from here.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border p-4">
                  <h3 className="font-semibold">Leave household</h3>
                  {isOwner ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      You&apos;re the owner. Make someone else the owner from Members, or delete the household, before leaving.
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 text-sm text-muted-foreground">
                        You lose access right away. Chores assigned to you become unassigned.
                      </p>
                      <Button variant="outline" className="mt-3" onClick={askLeave}>
                        <LogOut className="mr-2 h-4 w-4" />
                        Leave household
                      </Button>
                    </>
                  )}
                </div>
                {isOwner && (
                  <div className="rounded-md border border-destructive/40 p-4">
                    <h3 className="font-semibold">Delete household</h3>
                    <p className="mt-1 break-words text-sm text-muted-foreground">
                      Permanently deletes {householdDisplayName}: every chore, list, pet, maintenance record, photo and invite. Members keep their accounts. This cannot be undone.
                    </p>
                    <Button variant="destructive" className="mt-3" onClick={() => setIsDeleteOpen(true)}>
                      Delete household
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <ConfirmActionDialog request={confirm} onClose={() => setConfirm(null)} />

      <Dialog open={isDeleteOpen} onOpenChange={(open) => { setIsDeleteOpen(open); if (!open) setDeleteConfirm(''); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="break-words">Delete {householdDisplayName}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the household and everything in it for every member. Type the household name to confirm.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (deleteConfirm.trim() !== householdDisplayName || isDeleting) return;
              setIsDeleting(true);
              const deleted = await deleteHousehold(deleteConfirm);
              setIsDeleting(false);
              if (deleted) setIsDeleteOpen(false);
            }}
          >
            <Input
              aria-label="Household name"
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              placeholder={householdDisplayName}
              autoComplete="off"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsDeleteOpen(false)}>Keep household</Button>
              <Button type="submit" variant="destructive" disabled={deleteConfirm.trim() !== householdDisplayName || isDeleting}>
                {isDeleting ? 'Deleting…' : 'Delete forever'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  extra,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  extra?: React.ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="flex h-full min-w-0 items-start gap-3 p-3 sm:p-4">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground sm:text-sm">{label}</p>
          {/* Long names wrap (at most three lines) instead of running under the next card. */}
          <p className="line-clamp-3 break-words font-semibold [overflow-wrap:anywhere]" title={value}>{value}</p>
          {extra}
        </div>
      </CardContent>
    </Card>
  );
}

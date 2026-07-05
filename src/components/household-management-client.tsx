'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  arrayRemove,
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  AlertTriangle,
  Copy,
  Crown,
  Home,
  Loader2,
  LogOut,
  RefreshCw,
  Shield,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { buildNotificationDocument } from '@/lib/notifications';
import {
  assignableRoles,
  canChangeRole,
  canManageMember,
  canRemoveMember,
  canTransferOwnership,
  getEffectivePermissions,
  hasPermission,
  permissionGroups,
  permissionLabels,
} from '@/lib/permissions';
import type {
  AuditLog,
  HouseholdMember,
  HouseholdRole,
  InviteCode,
  PermissionOverrides,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

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

const formatDate = (value?: string) => {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleString();
};

const isActiveInvite = (invite: InviteCode) => {
  if (invite.revokedAt) return false;
  const expiresAt = new Date(invite.expiresAt);
  const maxUses = invite.maxUses ?? 1;
  return expiresAt > new Date() && (invite.useCount ?? 0) < maxUses;
};

const roleLabel = (role: HouseholdRole) => role.charAt(0).toUpperCase() + role.slice(1);

const hasOverrides = (member: HouseholdMember) => Object.keys(member.permissions || {}).length > 0;

export function HouseholdManagementClient() {
  const { currentUser, household, currentMember, permissions, leaveHousehold } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState('overview');
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [householdName, setHouseholdName] = useState(household?.name || '');
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [permissionsMember, setPermissionsMember] = useState<HouseholdMember | null>(null);
  const [draftPermissions, setDraftPermissions] = useState<PermissionOverrides>({});

  const canManageMembers = permissions['household.manageMembers'];
  const canManageInvites = permissions['household.manageInvites'];
  const canManageRoles = permissions['household.manageRoles'];
  const isOwner = currentMember?.role === 'owner';
  const activeInvites = useMemo(() => invites.filter(isActiveInvite), [invites]);
  const pendingMembers = useMemo(() => members.filter(member => member.role === 'newuser'), [members]);

  const fetchHouseholdData = useCallback(async () => {
    if (!household?.id) return;
    setIsLoading(true);
    try {
      const [membersSnap, invitesSnap, auditSnap] = await Promise.all([
        getDocs(collection(db, 'households', household.id, 'members')),
        getDocs(query(collection(db, 'inviteCodes'), where('householdId', '==', household.id))),
        getDocs(collection(db, 'households', household.id, 'auditLogs')),
      ]);

      const nextMembers = membersSnap.docs
        .map(snapshot => ({ uid: snapshot.id, ...snapshot.data() }) as HouseholdMember)
        .sort((a, b) => {
          const roleOrder = ['owner', 'admin', 'member', 'child', 'guest', 'newuser'];
          return roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.email.localeCompare(b.email);
        });
      const nextInvites = invitesSnap.docs
        .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }) as InviteCode)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const nextAudit = auditSnap.docs
        .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }) as AuditLog)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      setMembers(nextMembers);
      setInvites(nextInvites);
      setAuditLogs(nextAudit);
      setHouseholdName(household.name);
    } catch (error) {
      console.error('Failed to load household manager data', error);
      toast({ variant: 'destructive', title: 'Load Failed', description: 'Could not load household manager data.' });
    } finally {
      setIsLoading(false);
    }
  }, [household?.id, household?.name, toast]);

  useEffect(() => {
    fetchHouseholdData();
  }, [fetchHouseholdData]);

  useEffect(() => {
    const remindPendingMembers = async () => {
      if (!household?.id || !canManageMembers || pendingMembers.length === 0) return;
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
        batch.update(doc(db, 'households', household.id, 'members', member.uid), {
          lastNewUserReminderAt: nowIso,
        });
        batch.set(doc(collection(db, 'households', household.id, 'notifications')), buildNotificationDocument({
          householdId: household.id,
          category: 'system',
          title: 'Pending member approval',
          message: `${member.displayName || member.email} still needs a household role.`,
          deepLink: '/household?tab=members',
          sourceType: 'household-newuser-reminder',
          sourceId: member.uid,
        }));
        reminderCount++;
      });

      if (reminderCount > 0) {
        await batch.commit();
        await fetchHouseholdData();
      }
    };

    remindPendingMembers().catch((error) => {
      console.error('Failed to create pending member reminders', error);
    });
  }, [canManageMembers, fetchHouseholdData, household?.id, pendingMembers]);

  const saveHouseholdName = async () => {
    if (!household?.id || !householdName.trim()) return;
    setIsSavingName(true);
    try {
      await updateDoc(doc(db, 'households', household.id), {
        name: householdName.trim(),
        updatedAt: new Date().toISOString(),
      });
      toast({ title: 'Household Updated', description: 'The display name was saved.' });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to update household name', error);
      toast({ variant: 'destructive', title: 'Update Failed', description: 'Could not update the household name.' });
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
            if (existing.exists() && isActiveInvite({ id: existing.id, ...existing.data() } as InviteCode)) {
              throw new Error('Invite code collision.');
            }
            const now = new Date();
            const expiresAt = new Date(now.getTime() + INVITE_TTL_MINUTES * 60 * 1000);
            const createdInvite: InviteCode = {
              id: code,
              code,
              householdId: household.id,
              householdName: household.name,
              createdByUid: currentUser.uid,
              createdByEmail: currentUser.email,
              createdAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
              maxUses: 1,
              useCount: 0,
            };
            transaction.set(inviteRef, createdInvite);
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
      await navigator.clipboard.writeText(createdInviteCode);
      toast({ title: 'Invite Generated', description: 'The temporary invite code was copied to your clipboard.' });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to generate invite', error);
      toast({ variant: 'destructive', title: 'Invite Failed', description: 'Could not generate an invite code.' });
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
      toast({ title: 'Invite Revoked', description: 'The invite code can no longer be used.' });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to revoke invite', error);
      toast({ variant: 'destructive', title: 'Revoke Failed', description: 'Could not revoke the invite code.' });
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
      toast({ title: 'Invites Revoked', description: 'All active invite codes were revoked.' });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to revoke active invites', error);
      toast({ variant: 'destructive', title: 'Revoke Failed', description: 'Could not revoke active invites.' });
    }
  };

  const changeMemberRole = async (member: HouseholdMember, nextRole: HouseholdRole) => {
    if (!household?.id || !currentUser?.email || !currentMember || !canChangeRole(currentMember, member, nextRole)) return;
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
      toast({ title: 'Role Updated', description: `${member.displayName || member.email} is now ${roleLabel(nextRole)}.` });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to change member role', error);
      toast({ variant: 'destructive', title: 'Role Update Failed', description: 'Could not update the member role.' });
    }
  };

  const openPermissionDialog = (member: HouseholdMember) => {
    setPermissionsMember(member);
    setDraftPermissions(member.permissions || {});
  };

  const saveMemberPermissions = async () => {
    if (!household?.id || !permissionsMember || !currentUser?.email || !currentMember) return;
    if (!canManageMember(currentMember, permissionsMember) || permissionsMember.role === 'owner') return;
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      batch.update(doc(db, 'households', household.id, 'members', permissionsMember.uid), {
        permissions: draftPermissions,
      });
      batch.set(doc(db, 'users', permissionsMember.email), {
        permissions: draftPermissions,
      }, { merge: true });
      batch.set(doc(collection(db, 'households', household.id, 'auditLogs')), {
        actorUid: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        action: 'member.permissions_changed',
        targetUid: permissionsMember.uid,
        targetEmail: permissionsMember.email,
        targetName: permissionsMember.displayName,
        createdAt: now,
      });
      await batch.commit();
      setPermissionsMember(null);
      toast({ title: 'Permissions Updated', description: 'Custom permission overrides were saved.' });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to save permissions', error);
      toast({ variant: 'destructive', title: 'Permissions Failed', description: 'Could not update permissions.' });
    }
  };

  const removeMember = async (member: HouseholdMember) => {
    if (!household?.id || !currentUser?.email || !currentMember || !canRemoveMember(currentMember, member)) return;
    if (!window.confirm(`Remove ${member.displayName || member.email} from ${household.name}?`)) return;
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
      toast({ title: 'Member Removed', description: `${member.displayName || member.email} was removed from the household.` });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to remove member', error);
      toast({ variant: 'destructive', title: 'Remove Failed', description: 'Could not remove the member.' });
    }
  };

  const transferOwnership = async (member: HouseholdMember) => {
    if (!household?.id || !currentUser?.email || !currentMember || !canTransferOwnership(currentMember, member)) return;
    if (!window.confirm(`Transfer ownership to ${member.displayName || member.email}? You will become an admin.`)) return;
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
        message: `${member.displayName || member.email} is now the owner of ${household.name}.`,
        deepLink: '/household',
        sourceType: 'household-ownership-transfer',
        sourceId: member.uid,
      }));
      await batch.commit();
      toast({ title: 'Ownership Transferred', description: `${member.displayName || member.email} is now the household owner.` });
      await fetchHouseholdData();
    } catch (error) {
      console.error('Failed to transfer ownership', error);
      toast({ variant: 'destructive', title: 'Transfer Failed', description: 'Could not transfer ownership.' });
    }
  };

  if (!currentUser || !household) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Household Unavailable</CardTitle>
          <CardDescription>Create or join a household before managing household settings.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!hasPermission(currentMember?.role, 'household.view', currentMember?.permissions)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Waiting For Approval</CardTitle>
          <CardDescription>An owner or admin needs to assign your household role before you can access household settings.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/profile">Open Profile</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-headline text-3xl font-bold">Manage Household</h1>
          <p className="text-muted-foreground">Members, roles, invite codes, and household controls.</p>
        </div>
        <Button variant="outline" onClick={fetchHouseholdData} disabled={isLoading}>
          {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="flex min-h-48 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </CardContent>
        </Card>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid h-auto w-full grid-cols-2 md:grid-cols-6">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="invites">Invite Codes</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="danger">Danger Zone</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4 pt-4">
            <div className="grid gap-4 md:grid-cols-4">
              <SummaryCard icon={Home} label="Household" value={household.name} />
              <SummaryCard icon={Users} label="Members" value={String(members.length)} />
              <SummaryCard icon={Shield} label="Your Role" value={currentMember ? roleLabel(currentMember.role) : 'Unknown'} />
              <SummaryCard icon={UserPlus} label="Active Invites" value={String(activeInvites.length)} />
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Household Overview</CardTitle>
                <CardDescription>The display name can change without changing the household ID.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2">
                  <Label>Household ID</Label>
                  <Input value={household.id} readOnly />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="household-name">Display Name</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="household-name"
                      value={householdName}
                      onChange={(event) => setHouseholdName(event.target.value)}
                      disabled={!hasPermission(currentMember?.role, 'household.manageMembers', currentMember?.permissions)}
                    />
                    <Button onClick={saveHouseholdName} disabled={isSavingName || !householdName.trim() || !canManageMembers}>
                      {isSavingName && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="invites" className="space-y-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Temporary Invite Codes</CardTitle>
                <CardDescription>Invite codes expire after {INVITE_TTL_MINUTES} minutes and place joiners into the newuser approval state.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button onClick={generateInvite} disabled={!canManageInvites || isGeneratingInvite}>
                    {isGeneratingInvite ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
                    Generate Invite Code
                  </Button>
                  <Button variant="outline" onClick={revokeAllInvites} disabled={!canManageInvites || activeInvites.length === 0}>
                    Revoke Active Invites
                  </Button>
                </div>
                {invites.length === 0 ? (
                  <p className="rounded-md border p-4 text-sm text-muted-foreground">No invite codes have been generated.</p>
                ) : (
                  <div className="grid gap-3">
                    {invites.map(invite => (
                      <div key={invite.id} className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-lg font-semibold">{invite.code}</span>
                            <Badge variant={isActiveInvite(invite) ? 'default' : 'secondary'}>
                              {isActiveInvite(invite) ? 'Active' : invite.revokedAt ? 'Revoked' : 'Expired/Used'}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            Generated by {invite.createdByEmail} · expires {formatDate(invite.expiresAt)}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="icon" onClick={() => navigator.clipboard.writeText(invite.code)}>
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button variant="outline" onClick={() => revokeInvite(invite)} disabled={!canManageInvites || !isActiveInvite(invite)}>
                            Revoke
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="members" className="space-y-4 pt-4">
            {members.length === 0 ? (
              <Card><CardContent className="p-6 text-sm text-muted-foreground">No household members found.</CardContent></Card>
            ) : (
              <div className="grid gap-3">
                {members.map(member => (
                  <MemberCard
                    key={member.uid}
                    member={member}
                    actor={currentMember}
                    canManageRoles={canManageRoles}
                    onRoleChange={changeMemberRole}
                    onCustomize={openPermissionDialog}
                    onRemove={removeMember}
                    onTransferOwnership={transferOwnership}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="roles" className="space-y-4 pt-4">
            <div className="grid gap-4 md:grid-cols-2">
              {(['owner', 'admin', 'member', 'child', 'guest', 'newuser'] as HouseholdRole[]).map(role => (
                <Card key={role}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {role === 'owner' && <Crown className="h-5 w-5 text-primary" />}
                      {roleLabel(role)}
                    </CardTitle>
                    <CardDescription>
                      {role === 'newuser' ? 'System-only pending approval role.' : `${Object.values(getEffectivePermissions(role)).filter(Boolean).length} default permissions enabled.`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {permissionGroups.map(group => (
                      <div key={group.title}>
                        <p className="mb-1 text-sm font-medium">{group.title}</p>
                        <div className="flex flex-wrap gap-2">
                          {group.permissions
                            .filter(permission => getEffectivePermissions(role)[permission])
                            .map(permission => <Badge key={permission} variant="secondary">{permissionLabels[permission]}</Badge>)}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="activity" className="space-y-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Audit / System Activity</CardTitle>
                <CardDescription>Recent household management events.</CardDescription>
              </CardHeader>
              <CardContent>
                {auditLogs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No audit activity recorded yet.</p>
                ) : (
                  <div className="space-y-3">
                    {auditLogs.slice(0, 50).map(log => (
                      <div key={log.id} className="rounded-md border p-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <p className="font-medium">{log.action}</p>
                          <p className="text-xs text-muted-foreground">{formatDate(log.createdAt)}</p>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {log.actorName || log.actorEmail || 'System'}
                          {log.targetEmail ? ` · target ${log.targetName || log.targetEmail}` : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="danger" className="space-y-4 pt-4">
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive"><AlertTriangle /> Danger Zone</CardTitle>
                <CardDescription>Protected household exit and deletion controls.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border p-4">
                  <h3 className="font-semibold">Leave Household</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Non-owners can leave this household. Assigned chores are moved to unassigned.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-3"
                    onClick={() => {
                      if (window.confirm(`Leave ${household.name}?`)) void leaveHousehold();
                    }}
                    disabled={isOwner}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Leave Household
                  </Button>
                  {isOwner && <p className="mt-2 text-sm text-muted-foreground">Transfer ownership or delete the household before leaving.</p>}
                </div>
                <div className="rounded-md border border-destructive/40 p-4">
                  <h3 className="font-semibold">Delete Household</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Full recursive household deletion needs a server-side Firebase Function to verify ownership and delete subcollections/storage safely. This PR intentionally does not ship a client-side delete button.
                  </p>
                  <Button variant="destructive" className="mt-3" disabled>Server-side delete deferred</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={!!permissionsMember} onOpenChange={(open) => !open && setPermissionsMember(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl">
          <DialogHeader>
            <DialogTitle>Customize Permissions</DialogTitle>
            <DialogDescription>
              {permissionsMember?.displayName || permissionsMember?.email} currently uses the {permissionsMember?.role ? roleLabel(permissionsMember.role) : ''} preset.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh] pr-4">
            <div className="space-y-5">
              {permissionGroups.map(group => (
                <div key={group.title} className="space-y-2">
                  <h3 className="font-medium">{group.title}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {group.permissions.map(permission => {
                      const defaults = getEffectivePermissions(permissionsMember?.role);
                      const checked = draftPermissions[permission] ?? defaults[permission];
                      return (
                        <label key={permission} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => {
                              setDraftPermissions(prev => ({
                                ...prev,
                                [permission]: Boolean(value),
                              }));
                            }}
                          />
                          {permissionLabels[permission]}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => permissionsMember && setDraftPermissions(permissionsMember.permissions || {})}>
              Reset
            </Button>
            <Button onClick={saveMemberPermissions}>Save Permissions</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Icon className="h-5 w-5 text-primary" />
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="truncate font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function MemberCard({
  member,
  actor,
  canManageRoles,
  onRoleChange,
  onCustomize,
  onRemove,
  onTransferOwnership,
}: {
  member: HouseholdMember;
  actor: HouseholdMember | null;
  canManageRoles: boolean;
  onRoleChange: (member: HouseholdMember, role: HouseholdRole) => void;
  onCustomize: (member: HouseholdMember) => void;
  onRemove: (member: HouseholdMember) => void;
  onTransferOwnership: (member: HouseholdMember) => void;
}) {
  const canEditRole = Boolean(actor && canManageRoles && member.role !== 'owner' && canManageMember(actor, member));
  const effectivePermissions = getEffectivePermissions(member.role, member.permissions);
  const enabledCount = Object.values(effectivePermissions).filter(Boolean).length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{member.displayName || member.email}</p>
            <Badge variant={member.role === 'newuser' ? 'destructive' : 'secondary'}>{roleLabel(member.role)}</Badge>
            <Badge variant="outline">{member.status || 'active'}</Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">{member.email}</p>
          <p className="text-xs text-muted-foreground">
            Joined {formatDate(member.joinedAt)} · {hasOverrides(member) ? `${enabledCount} custom permissions` : 'Using default permissions'}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={member.role}
            onValueChange={(value) => onRoleChange(member, value as HouseholdRole)}
            disabled={!canEditRole}
          >
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {member.role === 'newuser' && <SelectItem value="newuser" disabled>Newuser</SelectItem>}
              {assignableRoles.map(role => (
                <SelectItem key={role} value={role}>{roleLabel(role)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => onCustomize(member)} disabled={!actor || member.role === 'owner' || !canManageMember(actor, member)}>
            Customize
          </Button>
          <Button variant="outline" onClick={() => onTransferOwnership(member)} disabled={!actor || !canTransferOwnership(actor, member)}>
            <Crown className="mr-2 h-4 w-4" />
            Transfer
          </Button>
          <Button
            variant="outline"
            className={cn('text-destructive hover:text-destructive')}
            onClick={() => onRemove(member)}
            disabled={!actor || !canRemoveMember(actor, member)}
          >
            <UserMinus className="mr-2 h-4 w-4" />
            Remove
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

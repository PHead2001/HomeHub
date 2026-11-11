'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence } from 'motion/react';
import { AlertTriangle, Copy, Home, Loader2, LogOut, Shield, UserPlus, Users } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase';
import { pendingReminderDue } from '@/lib/household-records';
import {
  canAssignRole,
  canEditPermissions,
  canManageInvites as mayManageInvites,
  canManageMember,
  canRemindPendingMembers,
  canRenameHousehold,
  canTransferOwnership,
} from '@/lib/household-policy';
import { assignableRoles } from '@/lib/permissions';
import { memberColorMap } from '@/lib/member-colors';
import type { HouseholdMember, HouseholdRole, InviteCode, PermissionOverrides } from '@/lib/types';
import { EmptyState } from '@/components/empty-state';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MemberAvatarStack } from '@/components/member-avatar';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Stagger } from '@/components/motion/stagger';
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
import {
  changeMemberRoleAction,
  createInviteAction,
  remindPendingMembersAction,
  removeMemberAction,
  renameHouseholdAction,
  revokeAllInvitesAction,
  revokeInviteAction,
  transferOwnershipAction,
  updateMemberPermissionsAction,
  type HouseholdActionResult,
} from '@/app/household/actions';
import { ConfirmActionDialog, type ConfirmRequest } from '@/components/household/confirm-action-dialog';
import {
  HOUSEHOLD_NAME_MAX,
  changedPermissions,
  INVITE_STATE_LABELS,
  describeAuditAction,
  householdManagerReads,
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
import { canSeeMemberEmails } from '@/lib/member-directory';

const INVITE_TTL_MINUTES = 30;

const householdTabs = ['overview', 'invites', 'members', 'roles', 'activity', 'danger'];

export function HouseholdManagementClient() {
  const { currentUser, household, currentMember, permissions, leaveHousehold, deleteHousehold } = useAuth();
  const { toast, toastError } = useToast();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');

  // What the viewer may do comes from the shared policy (`src/lib/household-policy.ts`),
  // the same functions the server actions enforce, never from the role alone.
  const canManageMembers = permissions['household.manageMembers'];
  const canManageInvites = mayManageInvites(currentMember).ok;
  const canRename = canRenameHousehold(currentMember).ok;
  // Without `household.view` the page is not shown and reads nothing; invite codes,
  // the activity log and contact documents also need it under firestore.rules.
  const reads = householdManagerReads(permissions);
  const canRemind = reads.page && canRemindPendingMembers(currentMember).ok;
  const isOwner = currentMember?.role === 'owner';
  // firestore.rules: audit entries are readable with `household.manageMembers`, the
  // invite list with `household.manageInvites` (role defaults and overrides both count).
  const canReadAudit = Boolean(canManageMembers);

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
  // Choosing a tab replaces the URL with ?tab=… (Overview has none), so refresh and Back
  // keep it. Shallow update: Next.js syncs useSearchParams with history.replaceState.
  const selectTab = useCallback((tab: string) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const shownTab = visibleTabs.includes(activeTab) ? activeTab : 'overview';

  const live = useHouseholdLiveData({
    householdId: household?.id,
    enabled: reads.page,
    currentMember,
    canListInvites: reads.invites && canManageInvites,
    canReadAudit: reads.audit && canReadAudit,
    canViewChores: reads.choreStats,
    canManageMembers: reads.contacts && canSeeMemberEmails(permissions),
    ownEmail: currentUser?.email ?? null,
  });
  const { members, auditLogs, choreStats, choreStatsReady, invites } = live;
  // Live: the auth context listens to the household document.
  const householdDisplayName = household?.name ?? '';

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

  // Daily "still pending" reminder: when someone who can approve opens this page
  // and a pending person has not been reminded about for 24 hours, the server
  // stamps the reminder and writes the notification (see remindPendingMembers).
  const remindingRef = useRef(false);
  useEffect(() => {
    const firebaseUser = auth.currentUser;
    if (!household?.id || !canRemind || !firebaseUser || remindingRef.current) return;
    const now = new Date();
    if (!pendingMembers.some((member) => pendingReminderDue(member.lastNewUserReminderAt, now))) return;
    remindingRef.current = true;
    const householdId = household.id;
    void (async () => {
      try {
        const result = await remindPendingMembersAction({ idToken: await firebaseUser.getIdToken(), householdId });
        if (!result.ok) console.warn('Pending member reminder was not sent', result.code);
      } catch (error) {
        console.error('Failed to create pending member reminders', error);
      } finally {
        remindingRef.current = false;
      }
    })();
  }, [canRemind, household?.id, pendingMembers]);

  /**
   * Calls a household server action with a fresh ID token. The server decides
   * (policy + transaction + activity log); a refusal or failure becomes a toast
   * and `null`.
   */
  const runAction = async <T,>(
    failTitle: string,
    call: (idToken: string) => Promise<HouseholdActionResult<T>>,
  ): Promise<T | null> => {
    try {
      const firebaseUser = auth.currentUser;
      if (!firebaseUser) {
        toast({ variant: 'destructive', title: failTitle, description: 'Your session has ended. Please sign in again.' });
        return null;
      }
      const result = await call(await firebaseUser.getIdToken());
      if (result.ok) return result.data;
      toast({ variant: 'destructive', title: failTitle, description: result.message });
      return null;
    } catch (error) {
      console.error(failTitle, error);
      toastError(error, failTitle);
      return null;
    }
  };

  const nameError = householdNameError(householdName);
  const showNameError = nameSubmitted && nameError;

  const saveHouseholdName = async () => {
    setNameSubmitted(true);
    if (!household?.id || nameError || !canRename) return;
    setIsSavingName(true);
    try {
      const householdId = household.id;
      const renamed = await runAction('Could not rename the household', (idToken) =>
        renameHouseholdAction({ idToken, householdId, name: householdName.trim() }));
      if (!renamed) return;
      setNameDraft(null);
      setNameSubmitted(false);
      toast({ title: 'Household renamed', description: `It's now called ${renamed.name}.` });
    } finally {
      setIsSavingName(false);
    }
  };

  // The buttons stay disabled until this is true, so a tap is never silently ignored
  // while the household or the member's permissions are still loading.
  const inviteReady = Boolean(household?.id && currentUser?.email && canManageInvites);

  const generateInvite = async () => {
    if (!inviteReady || !household?.id) return;
    setIsGeneratingInvite(true);
    try {
      const householdId = household.id;
      const invite = await runAction('Could not create an invite code', (idToken) =>
        createInviteAction({ idToken, householdId }));
      if (!invite) return;
      // The code exists now; copying is a convenience that must not turn a successful
      // invite into a reported failure (iOS often blocks clipboard writes after an await).
      const copied = await copyText(invite.code);
      toast({
        title: 'Invite code ready',
        description: copied
          ? `${invite.code} is copied. Share it within ${INVITE_TTL_MINUTES} minutes.`
          : `Share ${invite.code} within ${INVITE_TTL_MINUTES} minutes. It is also listed below.`,
      });
    } finally {
      setIsGeneratingInvite(false);
    }
  };

  const revokeInvite = async (invite: InviteCode) => {
    if (!household?.id || !canManageInvites) return;
    const householdId = household.id;
    const revoked = await runAction('Could not revoke the invite', (idToken) =>
      revokeInviteAction({ idToken, householdId, code: invite.code }));
    if (!revoked) return;
    toast({ title: 'Invite revoked', description: `${invite.code} can no longer be used.` });
  };

  const revokeAllInvites = async () => {
    if (!household?.id || !canManageInvites || activeInvites.length === 0) return;
    const householdId = household.id;
    const revoked = await runAction('Could not revoke the invites', (idToken) =>
      revokeAllInvitesAction({ idToken, householdId }));
    if (!revoked) return;
    toast({ title: 'Invites revoked', description: 'Every active invite code was revoked.' });
  };

  /** Approves a pending person or changes a member's role. */
  const changeMemberRole = async (member: HouseholdMember, nextRole: HouseholdRole) => {
    if (!household?.id || !canAssignRole(currentMember, member, nextRole).ok) return;
    const approving = member.role === 'newuser';
    const householdId = household.id;
    const changed = await runAction(approving ? 'Could not approve' : 'Could not change the role', (idToken) =>
      changeMemberRoleAction({ idToken, householdId, memberUid: member.uid, role: nextRole }));
    if (!changed) return;
    toast(approving
      ? { title: `${memberName(member)} is in`, description: `They joined as ${roleLabel(nextRole)}.` }
      : { title: 'Role updated', description: `${memberName(member)} is now ${roleLabel(nextRole)}.` });
  };

  const saveMemberPermissions = async (member: HouseholdMember, overrides: PermissionOverrides) => {
    if (!household?.id || !canEditPermissions(currentMember, member).ok) return false;
    const householdId = household.id;
    const saved = await runAction('Could not save permissions', (idToken) =>
      updateMemberPermissionsAction({ idToken, householdId, memberUid: member.uid, overrides, expectedRole: member.role }));
    if (!saved) return false;
    toast({ title: 'Permissions saved', description: `${memberName(member)}'s permissions were updated.` });
    return true;
  };

  const removeMember = async (member: HouseholdMember, denied = false) => {
    if (!household?.id || !canManageMember(currentMember, member).ok) return;
    const householdId = household.id;
    const removed = await runAction(denied ? 'Could not deny the request' : 'Could not remove the member', (idToken) =>
      removeMemberAction({ idToken, householdId, memberUid: member.uid }));
    if (!removed) return;
    toast(denied
      ? { title: 'Request denied', description: `${memberName(member)} was not added to the household.` }
      : { title: 'Member removed', description: `${memberName(member)} was removed from the household.` });
  };

  const transferOwnership = async (member: HouseholdMember) => {
    if (!household?.id || !canTransferOwnership(currentMember, member).ok) return;
    const householdId = household.id;
    const transferred = await runAction('Could not transfer ownership', (idToken) =>
      transferOwnershipAction({ idToken, householdId, memberUid: member.uid }));
    if (!transferred) return;
    toast({ title: 'Ownership transferred', description: `${memberName(member)} is now the household owner.` });
  };

  /** What the viewer may do to a member (shared policy); the card shows nothing else. */
  const actionsFor = (member: HouseholdMember): MemberActions => ({
    roles: assignableRoles.filter((role) => canAssignRole(currentMember, member, role).ok),
    canCustomize: canEditPermissions(currentMember, member).ok,
    canTransfer: canTransferOwnership(currentMember, member).ok,
    canRemove: canManageMember(currentMember, member).ok,
  });

  const askRoleChange = (member: HouseholdMember, nextRole: HouseholdRole) => setConfirm({
    title: `Change ${memberName(member)} to ${roleLabel(nextRole)}?`,
    description: `They get what a ${roleLabel(nextRole).toLowerCase()} can do right away. Any custom permissions they have are reset to the ${roleLabel(nextRole).toLowerCase()} defaults.`,
    confirmLabel: 'Change role',
    onConfirm: () => changeMemberRole(member, nextRole),
  });

  /** Confirms a permission save; resolves false when cancelled or refused. */
  const askSavePermissions = (member: HouseholdMember, overrides: PermissionOverrides) => new Promise<boolean>((resolve) => {
    const count = changedPermissions(member.role, member.permissions, overrides).length;
    setConfirm({
      title: `Save permissions for ${memberName(member)}?`,
      description: `${count} ${count === 1 ? 'permission changes' : 'permissions change'} for them right away.`,
      confirmLabel: 'Save permissions',
      onConfirm: async () => resolve(await saveMemberPermissions(member, overrides)),
      onCancel: () => resolve(false),
    });
  });

  const askRemove = (member: HouseholdMember) => setConfirm({
    title: `Remove ${memberName(member)}?`,
    description: `They lose access to ${householdDisplayName} right away. Open chores assigned to them become unassigned.`,
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
    selectTab('roles');
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

  if (!reads.page) {
    const pending = !currentMember || currentMember.role === 'newuser' || currentMember.status === 'pending';
    return (
      <Card>
        <CardHeader>
          <CardTitle>{pending ? 'Waiting for approval' : 'Household settings are not available to you'}</CardTitle>
          <CardDescription>
            {pending
              ? 'An owner or admin needs to choose your role before you can see household settings.'
              : 'An owner or admin can turn on View household for you.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/profile">Open Profile</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const memberStatText = pendingMembers.length > 0
    ? `${approvedMembers.length} · ${pendingMembers.length} pending`
    : String(approvedMembers.length);
  // Counts tick in (H12); the text form is the card's title.
  const memberStatValue = pendingMembers.length > 0
    ? <><NumberTicker value={approvedMembers.length} /> · <NumberTicker value={pendingMembers.length} /> pending</>
    : <NumberTicker value={approvedMembers.length} />;

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
        <Tabs value={shownTab} onValueChange={selectTab}>
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
                title={memberStatText}
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
              <SummaryCard icon={UserPlus} label="Active invites" value={<NumberTicker value={activeInvites.length} />} title={String(activeInvites.length)} />
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Household name</CardTitle>
                <CardDescription>Everyone in the household sees this name. Changing it never changes your invite codes or data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {canRename ? (
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
                      <Button onClick={generateInvite} disabled={isGeneratingInvite || !inviteReady}>
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
                      action={{ label: isGeneratingInvite ? 'Creating…' : 'Create invite code', icon: <UserPlus className="mr-2 h-4 w-4" />, onClick: () => { if (!isGeneratingInvite) void generateInvite(); }, disabled: isGeneratingInvite || !inviteReady }}
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
                    showEmail={canSeeMemberEmails(permissions) || member.uid === currentMember?.uid}
                    stats={choreStats.get(member.uid) ?? (choreStatsReady ? { doneThisWeek: 0, open: 0 } : undefined)}
                    actions={actionsFor(member)}
                    onRoleChange={askRoleChange}
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
                    action={canManageInvites ? { label: 'Create an invite code', icon: <UserPlus className="mr-2 h-4 w-4" />, onClick: () => selectTab('invites') } : undefined}
                  />
                </Card>
              </>
            ) : (
              <Stagger className="grid gap-3 md:grid-cols-2" data-testid="household-member-list">
                {(canManageMembers ? approvedMembers : members).map((member) => (
                  <MemberCard
                    key={member.uid}
                    member={member}
                    color={colors.get(member.uid)!}
                    isSelf={member.uid === currentMember?.uid}
                    showEmail={canSeeMemberEmails(permissions) || member.uid === currentMember?.uid}
                    stats={member.role === 'newuser' ? undefined : choreStats.get(member.uid) ?? (choreStatsReady ? { doneThisWeek: 0, open: 0 } : undefined)}
                    actions={actionsFor(member)}
                    onRoleChange={askRoleChange}
                    onCustomize={openCustomize}
                    onTransfer={askTransfer}
                    onRemove={askRemove}
                  />
                ))}
              </Stagger>
            )}
          </TabsContent>

          <TabsContent value="roles" className="space-y-4 pt-4">
            <RolesPanel
              members={members}
              colors={colors}
              viewerRole={currentMember?.role}
              selected={matrixSelection}
              onSelect={setMatrixSelection}
              actor={currentMember}
              onSave={askSavePermissions}
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
  title,
  extra,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Text, or a live number (`NumberTicker`) with `title` as its text form. */
  value: React.ReactNode;
  title?: string;
  extra?: React.ReactNode;
}) {
  return (
    <Card className="min-w-0" data-testid={`household-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="flex h-full min-w-0 items-start gap-3 p-3 sm:p-4">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground sm:text-sm">{label}</p>
          {/* Long names wrap (at most three lines) instead of running under the next card. */}
          <p className="line-clamp-3 break-words font-semibold [overflow-wrap:anywhere]" title={title ?? (typeof value === 'string' ? value : undefined)} data-testid="household-stat-value">{value}</p>
          {extra}
        </div>
      </CardContent>
    </Card>
  );
}

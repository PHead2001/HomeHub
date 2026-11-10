'use client';

import { useMemo, useState } from 'react';
import { Crown, Loader2, RotateCcw } from 'lucide-react';
import { MemberAvatar } from '@/components/member-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { MemberColor } from '@/lib/member-colors';
import { canEditPermissions, permissionChanges, refusalMessage, type PolicyRefusal } from '@/lib/household-policy';
import { getEffectivePermissions, getRolePresetPermissions } from '@/lib/permissions';
import type { HouseholdMember, HouseholdPermission, HouseholdRole, PermissionOverrides } from '@/lib/types';
import {
  MATRIX_ROLES,
  changedPermissions,
  lockedPermissionCells,
  memberName,
  normalizeOverrides,
  permissionDraftKey,
  roleLabel,
  roleSummary,
  togglePermissionOverride,
} from './household-model';
import { PermissionMatrix, type MatrixColumn } from './permission-matrix';

/** Select value for the role-preset comparison (no member chosen). */
export const ALL_ROLES = '__roles__';

/** Why the viewer cannot edit the chosen member, in plain language. */
const READ_ONLY_REASONS: Partial<Record<PolicyRefusal, string>> = {
  self: "You can't change your own permissions.",
  rank: 'You can only change people with a lower role than yours.',
  missing_permission: 'You need the Manage roles permission to change it.',
};

/**
 * Roles tab (D12/H25): a living permission matrix. By default it compares the
 * built-in role presets side by side. Choosing a member shows their role's
 * defaults next to their own permissions. The member column is editable only
 * when the shared policy (`src/lib/household-policy.ts`) lets the viewer edit
 * that person: `household.manageRoles`, never yourself, never someone at or
 * above your own role. Owner-only permissions and permissions the viewer does
 * not hold are locked. Saving goes through the server action, which applies the
 * same policy again.
 */
export function RolesPanel({
  members,
  colors,
  viewerRole,
  selected,
  onSelect,
  actor,
  onSave,
}: {
  members: readonly HouseholdMember[];
  colors: Map<string, MemberColor>;
  viewerRole: HouseholdRole | undefined;
  /** Member uid shown next to their role default, or `ALL_ROLES`. Customize permissions in Members sets it. */
  selected: string;
  onSelect: (value: string) => void;
  /** The viewer's own membership record; decides what can be edited. */
  actor: HouseholdMember | null | undefined;
  onSave: (member: HouseholdMember, overrides: PermissionOverrides) => Promise<boolean>;
}) {
  const approved = useMemo(() => members.filter((m) => m.role !== 'newuser'), [members]);
  const member = approved.find((m) => m.uid === selected) ?? null;
  const access = member ? canEditPermissions(actor, member) : null;
  const editable = Boolean(access?.ok);
  const saved = member ? normalizeOverrides(member.role, member.permissions) : {};
  const [saving, setSaving] = useState(false);

  // The draft belongs to one member, role and saved state: choosing someone else,
  // or a role or permission change arriving live, starts again from what is stored.
  const draftKey = permissionDraftKey(member);
  const [draftState, setDraftState] = useState<{ key: string; overrides: PermissionOverrides } | null>(null);
  const draft = draftState && draftState.key === draftKey ? draftState.overrides : saved;
  const setDraft = (update: PermissionOverrides | ((prev: PermissionOverrides) => PermissionOverrides)) => {
    setDraftState({ key: draftKey, overrides: typeof update === 'function' ? update(draft) : update });
  };

  const changes = member ? changedPermissions(member.role, saved, draft) : [];
  const customizedFromDefault = member ? new Set(Object.keys(draft) as HouseholdPermission[]) : new Set<HouseholdPermission>();
  // The server refuses a save that grants something the viewer does not hold; say so before they try.
  const saveDecision = member && editable
    ? canEditPermissions(actor, member, permissionChanges(member.role, saved, draft))
    : null;
  const saveBlocked = saveDecision && !saveDecision.ok ? refusalMessage(saveDecision.reason) : null;

  // Locked cells: the two owner-only permissions, and any permission the viewer
  // does not hold that this member does not already have (ticking it would be a
  // grant). A permission the member already has can still be taken away.
  const locked = member && editable ? lockedPermissionCells(actor, member.role, saved) : {};

  const columns: MatrixColumn[] = member
    ? [
        {
          id: `role-${member.role}`,
          label: `${roleLabel(member.role)} default`,
          values: getRolePresetPermissions(member.role),
        },
        {
          id: `member-${member.uid}`,
          label: memberName(member),
          adornment: (
            <MemberAvatar uid={member.uid} name={memberName(member)} photoUrl={member.avatarUrl} color={colors.get(member.uid)} size="sm" decorative />
          ),
          values: getEffectivePermissions(member.role, draft),
          highlight: true,
          editable: editable
            ? {
                onToggle: (permission) => setDraft((prev) => togglePermissionOverride(member.role, prev, permission)),
                locked,
                changed: customizedFromDefault,
                disabled: saving,
              }
            : undefined,
        },
      ]
    : MATRIX_ROLES.map((role) => ({
        id: `role-${role}`,
        label: roleLabel(role),
        adornment: role === 'owner' ? <Crown aria-hidden className="h-4 w-4 text-primary" /> : undefined,
        values: getRolePresetPermissions(role),
        highlight: role === viewerRole,
      }));

  const save = async () => {
    if (!member) return;
    setSaving(true);
    try {
      await onSave(member, normalizeOverrides(member.role, draft));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="gap-3 md:flex-row md:items-end md:justify-between md:space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Roles and permissions</CardTitle>
          <CardDescription>
            {member
              ? editable
                ? `Tick or clear a box to give ${memberName(member)} more or less than a ${roleLabel(member.role).toLowerCase()} gets by default.`
                : `What ${memberName(member)} can do. ${member.role === 'owner'
                  ? 'The owner can do everything.'
                  : access && !access.ok ? READ_ONLY_REASONS[access.reason] ?? refusalMessage(access.reason) : ''}`
              : 'What each role can do. Pending people see nothing until someone approves them.'}
          </CardDescription>
        </div>
        <div className="grid gap-1 md:w-64">
          <Label htmlFor="matrix-view">Show</Label>
          <Select value={member ? member.uid : ALL_ROLES} onValueChange={onSelect}>
            <SelectTrigger id="matrix-view">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ROLES}>All roles</SelectItem>
              {approved.map((m) => (
                <SelectItem key={m.uid} value={m.uid}>{memberName(m)} ({roleLabel(m.role)})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!member && (
          <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {MATRIX_ROLES.map((role) => (
              <li key={role} className="rounded-md border border-border-subtle p-3">
                <span className="font-semibold">{roleLabel(role)}</span>
                <span className="text-muted-foreground"> · {roleSummary(role)}</span>
              </li>
            ))}
          </ul>
        )}
        <PermissionMatrix
          columns={columns}
          caption={member ? `Permissions for ${memberName(member)} compared with the ${roleLabel(member.role)} default` : 'Permissions for each role'}
        />
        {member && editable && (
          <p className="text-xs text-muted-foreground" data-testid="matrix-lock-note">
            Locked boxes can&apos;t be changed: deleting the household and transferring ownership belong to the owner alone, and you can&apos;t give a permission you don&apos;t have yourself.
          </p>
        )}
        {member && editable && (
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {saveBlocked ? saveBlocked : changes.length === 0
                ? customizedFromDefault.size === 0
                  ? `Using the ${roleLabel(member.role).toLowerCase()} defaults.`
                  : `${customizedFromDefault.size} ${customizedFromDefault.size === 1 ? 'permission differs' : 'permissions differ'} from the default.`
                : `${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {customizedFromDefault.size > 0 && (
                <Button variant="ghost" onClick={() => setDraft({})} disabled={saving}>
                  <RotateCcw className="mr-2 h-4 w-4" /> Use role defaults
                </Button>
              )}
              {changes.length > 0 && (
                <Button variant="outline" onClick={() => setDraft(saved)} disabled={saving}>Discard</Button>
              )}
              <Button onClick={save} disabled={saving || changes.length === 0 || Boolean(saveBlocked)}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save permissions
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

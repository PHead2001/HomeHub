import type {
  HouseholdMember,
  HouseholdPermission,
  HouseholdRole,
  PermissionOverrides,
  UserRole,
} from '@/lib/types';

export const householdPermissions: HouseholdPermission[] = [
  'household.view',
  'household.manageMembers',
  'household.manageInvites',
  'household.manageRoles',
  'household.delete',
  'household.transferOwnership',
  'chores.view',
  'chores.complete',
  'chores.create',
  'chores.edit',
  'chores.delete',
  'chores.assign',
  'shopping.view',
  'shopping.edit',
  'shopping.delete',
  'pets.view',
  'pets.addLogs',
  'pets.editProfiles',
  'pets.deleteLogs',
  'maintenance.view',
  'maintenance.createLogs',
  'maintenance.edit',
  'maintenance.delete',
  'automation.view',
  'automation.control',
  'automation.manage',
  'notifications.view',
  'notifications.dismiss',
];

export const permissionLabels: Record<HouseholdPermission, string> = {
  'household.view': 'View household',
  'household.manageMembers': 'Manage members',
  'household.manageInvites': 'Manage invites',
  'household.manageRoles': 'Manage roles',
  'household.delete': 'Delete household',
  'household.transferOwnership': 'Transfer ownership',
  'chores.view': 'View chores',
  'chores.complete': 'Complete chores',
  'chores.create': 'Create chores',
  'chores.edit': 'Edit chores',
  'chores.delete': 'Delete chores',
  'chores.assign': 'Assign chores',
  'shopping.view': 'View shopping',
  'shopping.edit': 'Edit shopping',
  'shopping.delete': 'Delete shopping',
  'pets.view': 'View pets',
  'pets.addLogs': 'Add pet logs',
  'pets.editProfiles': 'Edit pet profiles',
  'pets.deleteLogs': 'Delete pet logs',
  'maintenance.view': 'View maintenance',
  'maintenance.createLogs': 'Create maintenance logs',
  'maintenance.edit': 'Edit maintenance',
  'maintenance.delete': 'Delete maintenance',
  'automation.view': 'View automation',
  'automation.control': 'Control automation',
  'automation.manage': 'Manage automation',
  'notifications.view': 'View notifications',
  'notifications.dismiss': 'Dismiss notifications',
};

export const permissionGroups: { title: string; permissions: HouseholdPermission[] }[] = [
  {
    title: 'Household',
    permissions: [
      'household.view',
      'household.manageMembers',
      'household.manageInvites',
      'household.manageRoles',
      'household.delete',
      'household.transferOwnership',
    ],
  },
  {
    title: 'Chores',
    permissions: ['chores.view', 'chores.complete', 'chores.create', 'chores.edit', 'chores.delete', 'chores.assign'],
  },
  {
    title: 'Shopping',
    permissions: ['shopping.view', 'shopping.edit', 'shopping.delete'],
  },
  {
    title: 'Pets',
    permissions: ['pets.view', 'pets.addLogs', 'pets.editProfiles', 'pets.deleteLogs'],
  },
  {
    title: 'Maintenance',
    permissions: ['maintenance.view', 'maintenance.createLogs', 'maintenance.edit', 'maintenance.delete'],
  },
  {
    title: 'Automation',
    permissions: ['automation.view', 'automation.control', 'automation.manage'],
  },
  {
    title: 'Notifications',
    permissions: ['notifications.view', 'notifications.dismiss'],
  },
];

const allPermissions = (): Record<HouseholdPermission, boolean> => {
  return householdPermissions.reduce((acc, permission) => {
    acc[permission] = true;
    return acc;
  }, {} as Record<HouseholdPermission, boolean>);
};

const noPermissions = (): Record<HouseholdPermission, boolean> => {
  return householdPermissions.reduce((acc, permission) => {
    acc[permission] = false;
    return acc;
  }, {} as Record<HouseholdPermission, boolean>);
};

export const normalizeRole = (role?: UserRole | HouseholdRole | null): HouseholdRole => {
  if (role === 'owner' || role === 'admin' || role === 'member' || role === 'child' || role === 'guest' || role === 'newuser') {
    return role;
  }
  if (role === 'super-admin') return 'owner';
  if (role === 'user') return 'member';
  return 'member';
};

export const assignableRoles: HouseholdRole[] = ['admin', 'member', 'child', 'guest'];

export const getRolePresetPermissions = (roleInput?: UserRole | HouseholdRole | null): Record<HouseholdPermission, boolean> => {
  const role = normalizeRole(roleInput);
  if (role === 'owner') return allPermissions();
  if (role === 'admin') {
    return {
      ...allPermissions(),
      'household.delete': false,
      'household.transferOwnership': false,
    };
  }
  if (role === 'member') {
    return {
      ...noPermissions(),
      'household.view': true,
      'chores.view': true,
      'chores.complete': true,
      'chores.create': true,
      'chores.edit': true,
      'chores.assign': true,
      'shopping.view': true,
      'shopping.edit': true,
      'pets.view': true,
      'pets.addLogs': true,
      'maintenance.view': true,
      'maintenance.createLogs': true,
      'maintenance.edit': true,
      'automation.view': true,
      'notifications.view': true,
      'notifications.dismiss': true,
    };
  }
  if (role === 'child') {
    return {
      ...noPermissions(),
      'household.view': true,
      'chores.view': true,
      'chores.complete': true,
      'pets.view': true,
      'pets.addLogs': true,
      'notifications.view': true,
      'notifications.dismiss': true,
    };
  }
  if (role === 'guest') {
    return {
      ...noPermissions(),
      'household.view': true,
      'chores.view': true,
      'shopping.view': true,
      'pets.view': true,
      'maintenance.view': true,
      'notifications.view': true,
    };
  }
  return noPermissions();
};

export const getEffectivePermissions = (
  roleInput?: UserRole | HouseholdRole | null,
  overrides?: PermissionOverrides
) => {
  const role = normalizeRole(roleInput);
  if (role === 'owner') return getRolePresetPermissions(role);
  return {
    ...getRolePresetPermissions(role),
    ...(overrides || {}),
  };
};

export const hasPermission = (
  roleInput: UserRole | HouseholdRole | null | undefined,
  permission: HouseholdPermission,
  overrides?: PermissionOverrides
) => {
  return Boolean(getEffectivePermissions(roleInput, overrides)[permission]);
};

export const canManageMember = (actor?: HouseholdMember | null, target?: HouseholdMember | null) => {
  if (!actor || !target) return false;
  if (actor.uid === target.uid) return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'admin') return target.role !== 'owner';
  return false;
};

export const canRemoveMember = canManageMember;

export const canChangeRole = (actor?: HouseholdMember | null, target?: HouseholdMember | null, nextRole?: HouseholdRole) => {
  if (!actor || !target) return false;
  if (nextRole === 'newuser') return false;
  if (nextRole === 'owner') return false;
  if (target.role === 'owner') return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'admin') return true;
  return false;
};

export const canTransferOwnership = (actor?: HouseholdMember | null, target?: HouseholdMember | null) => {
  return Boolean(actor && target && actor.role === 'owner' && actor.uid !== target.uid && target.role !== 'newuser');
};

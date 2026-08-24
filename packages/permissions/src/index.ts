export const Permission = {
  LISTEN: "library:listen",
  CONTRIBUTE: "music:contribute",
  REMOVE_MUSIC: "music:remove",
  CREATE_REQUEST: "request:create",
  FULFILL_REQUEST: "request:fulfill",
  INVITE_MEMBERS: "members:invite",
  MANAGE_MEMBERS: "members:manage",
  MANAGE_LIBRARY: "library:manage"
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];
export type LibraryRole = "OWNER" | "ADMIN" | "MEMBER";

const member = [
  Permission.LISTEN,
  Permission.CONTRIBUTE,
  Permission.CREATE_REQUEST,
  Permission.FULFILL_REQUEST
] as const;

export const ROLE_PERMISSIONS: Record<LibraryRole, readonly Permission[]> = {
  MEMBER: member,
  ADMIN: [...member, Permission.REMOVE_MUSIC, Permission.INVITE_MEMBERS, Permission.MANAGE_MEMBERS],
  OWNER: [...member, Permission.REMOVE_MUSIC, Permission.INVITE_MEMBERS, Permission.MANAGE_MEMBERS, Permission.MANAGE_LIBRARY]
};

export function permissionsFor(role: LibraryRole, overrides?: string[] | null): Permission[] {
  if (!overrides) return [...ROLE_PERMISSIONS[role]];
  const known = new Set(Object.values(Permission));
  return overrides.filter((value): value is Permission => known.has(value as Permission));
}

export function can(role: LibraryRole, permission: Permission, overrides?: string[] | null): boolean {
  return permissionsFor(role, overrides).includes(permission);
}

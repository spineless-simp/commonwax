import { Permission } from "@commonwax/permissions";
import type { SessionUser } from "./types";

export { Permission };

/**
 * The UI asks the same permission matrix the API gates on, so a permission
 * that is renamed or removed in `@commonwax/permissions` becomes a type error
 * here instead of a control that silently stops appearing.
 */
export function can(user: SessionUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

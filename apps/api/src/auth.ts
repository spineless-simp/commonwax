import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import { db, type Membership, type User, type Library } from "@commonwax/db";
import { Permission, permissionsFor } from "@commonwax/permissions";
import { config } from "./config.js";
import { asStringArray, randomToken, sha256 } from "./utils.js";

export const PASSWORD_ROUNDS = 12;

/**
 * A bcrypt hash of an unguessable value, compared against when no account
 * matches so that a wrong email and a wrong password cost the same time. It is
 * generated once per process; the plaintext is never retained.
 */
const absentAccountHash = bcrypt.hashSync(randomToken(), PASSWORD_ROUNDS);

/** Verifies a password without leaking, through timing, whether the account exists. */
export async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  const matched = await bcrypt.compare(password, passwordHash ?? absentAccountHash);
  return Boolean(passwordHash) && matched;
}

/**
 * The two permissions a blocked member loses. Fulfilling a request travels with
 * contributing because it *is* an upload — leaving it behind would block the
 * front door and leave the side one open.
 */
const CONTRIBUTION_PERMISSIONS: readonly Permission[] = [Permission.CONTRIBUTE, Permission.FULFILL_REQUEST];

/**
 * What this membership may do right now. Blocking uploads subtracts from the
 * result rather than writing a permission list onto the row, so a member who is
 * blocked and then promoted stays blocked, and unblocking gives back exactly
 * what their current role grants — no snapshot to go stale in between.
 */
export function effectivePermissions(membership: Pick<Membership, "role" | "permissionOverrides" | "uploadsBlockedAt">): Permission[] {
  const granted = permissionsFor(membership.role, asStringArray(membership.permissionOverrides));
  if (!membership.uploadsBlockedAt) return granted;
  return granted.filter((permission) => !CONTRIBUTION_PERMISSIONS.includes(permission));
}

export type AuthContext = {
  user: User;
  membership: Membership;
  library: Library;
  permissions: Permission[];
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const cookieName = "commonwax_session";

export async function createSession(userId: string, response: Response): Promise<void> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000);
  await db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt } });
  response.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    expires: expiresAt,
    path: "/"
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/" });
}

export async function destroySession(request: Request, response: Response): Promise<void> {
  const token = request.cookies?.[cookieName];
  if (typeof token === "string") await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  clearSessionCookie(response);
}

export async function authenticate(request: Request, _response: Response, next: NextFunction): Promise<void> {
  try {
    const token = request.cookies?.[cookieName];
    if (typeof token !== "string") return next();
    const session = await db.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        user: {
          include: {
            memberships: { include: { library: true }, orderBy: { joinedAt: "asc" }, take: 1 }
          }
        }
      }
    });
    if (!session) return next();
    if (session.expiresAt <= new Date()) {
      await db.session.delete({ where: { id: session.id } });
      return next();
    }
    const membership = session.user.memberships[0];
    if (!membership) return next();
    request.auth = {
      user: session.user,
      membership,
      library: membership.library,
      permissions: effectivePermissions(membership)
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  if (!request.auth) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
}

/**
 * A changed password ends every other session. The cookie on this request is
 * kept, so the person who made the change is not signed out of the tab they
 * made it in — everywhere else has to sign in again with the new one.
 */
export async function revokeOtherSessions(request: Request, userId: string): Promise<void> {
  const token = request.cookies?.[cookieName];
  await db.session.deleteMany({
    where: { userId, ...(typeof token === "string" ? { tokenHash: { not: sha256(token) } } : {}) }
  });
}

/**
 * Signs one account out everywhere at once. Removing somebody from the Library
 * already costs them their permissions, but their cookie would otherwise stay a
 * valid session until it expired; this is what makes "removed" immediate.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

/**
 * Expired rows are already rejected on use; sweeping them keeps the session
 * table from growing without bound over the life of a deployment.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return count;
}

/**
 * Gates on the list `authenticate` already resolved rather than re-deriving it
 * from the role, so every subtraction `effectivePermissions` makes — an upload
 * block above all — reaches every route without each one remembering to ask.
 */
export function requirePermission(permission: Permission) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.auth) {
      response.status(401).json({ error: "Sign in to continue." });
      return;
    }
    if (!request.auth.permissions.includes(permission)) {
      response.status(403).json({ error: "You do not have permission to do that." });
      return;
    }
    next();
  };
}

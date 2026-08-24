import type { NextFunction, Request, Response } from "express";
import { db, type Membership, type User, type Library } from "@commonwax/db";
import { can, permissionsFor, type Permission } from "@commonwax/permissions";
import { config } from "./config.js";
import { asStringArray, randomToken, sha256 } from "./utils.js";

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

export async function destroySession(request: Request, response: Response): Promise<void> {
  const token = request.cookies?.[cookieName];
  if (typeof token === "string") await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  response.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: "/" });
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
      permissions: permissionsFor(membership.role, asStringArray(membership.permissionOverrides))
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

export function requirePermission(permission: Permission) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.auth) {
      response.status(401).json({ error: "Sign in to continue." });
      return;
    }
    const overrides = asStringArray(request.auth.membership.permissionOverrides);
    if (!can(request.auth.membership.role, permission, overrides)) {
      response.status(403).json({ error: "You do not have permission to do that." });
      return;
    }
    next();
  };
}

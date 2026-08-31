import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { Permission, permissionsFor } from "@commonwax/permissions";
import { PASSWORD_ROUNDS, effectivePermissions, requireAuth, requirePermission, verifyPassword } from "./auth.js";

function mockResponse() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { response.statusCode = code; return response; },
    json(value: unknown) { response.body = value; return response; }
  };
  return response as unknown as Response & { statusCode: number; body: any };
}

/**
 * The context `authenticate` would have built for this membership. `permissions`
 * has to be resolved here rather than left empty, because that resolved list —
 * not the role — is what `requirePermission` reads.
 */
function authContext(
  role: "OWNER" | "ADMIN" | "MEMBER",
  permissionOverrides: unknown = null,
  uploadsBlockedAt: Date | null = null
) {
  const membership = { role, permissionOverrides, uploadsBlockedAt };
  return {
    user: { id: "user" },
    membership,
    library: { id: "library" },
    permissions: effectivePermissions(membership as any)
  } as unknown as Request["auth"];
}

describe("verifyPassword", () => {
  it("accepts the correct password", async () => {
    const hash = await bcrypt.hash("correct horse battery", PASSWORD_ROUNDS);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await bcrypt.hash("correct horse battery", PASSWORD_ROUNDS);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("still performs a comparison when the account does not exist", async () => {
    // The absent-account path must run bcrypt too, otherwise the response time
    // discloses which email addresses have accounts.
    const started = process.hrtime.bigint();
    expect(await verifyPassword("anything", null)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(elapsedMs).toBeGreaterThan(5);
  });
});

describe("requireAuth", () => {
  it("rejects an anonymous request", () => {
    const next = vi.fn();
    const response = mockResponse();
    requireAuth({} as Request, response, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  it("passes an authenticated request through", () => {
    const next = vi.fn();
    requireAuth({ auth: authContext("MEMBER") } as Request, mockResponse(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
  });
});

describe("requirePermission", () => {
  it("answers 401, not 403, when nobody is signed in", () => {
    const next = vi.fn();
    const response = mockResponse();
    requirePermission(Permission.LISTEN)({} as Request, response, next as unknown as NextFunction);
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a role that holds the permission", () => {
    const next = vi.fn();
    requirePermission(Permission.CONTRIBUTE)(
      { auth: authContext("MEMBER") } as Request,
      mockResponse(),
      next as unknown as NextFunction
    );
    expect(next).toHaveBeenCalled();
  });

  it("denies a role that does not hold the permission", () => {
    const next = vi.fn();
    const response = mockResponse();
    requirePermission(Permission.MANAGE_LIBRARY)(
      { auth: authContext("MEMBER") } as Request,
      response,
      next as unknown as NextFunction
    );
    expect(response.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("gates on the permission matrix, not the role name, when overrides are set", () => {
    const next = vi.fn();
    requirePermission(Permission.MANAGE_LIBRARY)(
      { auth: authContext("MEMBER", [Permission.MANAGE_LIBRARY]) } as Request,
      mockResponse(),
      next as unknown as NextFunction
    );
    expect(next).toHaveBeenCalled();
  });

  it("ignores unknown strings smuggled into permission overrides", () => {
    const next = vi.fn();
    const response = mockResponse();
    requirePermission(Permission.MANAGE_LIBRARY)(
      { auth: authContext("MEMBER", ["library:*", "admin", "library:manage "]) } as Request,
      response,
      next as unknown as NextFunction
    );
    expect(response.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("treats a malformed overrides value as absent and falls back to the role", () => {
    const next = vi.fn();
    requirePermission(Permission.CONTRIBUTE)(
      { auth: authContext("MEMBER", { not: "an array" }) } as Request,
      mockResponse(),
      next as unknown as NextFunction
    );
    expect(next).toHaveBeenCalled();
  });

  it("narrows an owner when overrides remove a permission", () => {
    const next = vi.fn();
    const response = mockResponse();
    requirePermission(Permission.REMOVE_MUSIC)(
      { auth: authContext("OWNER", [Permission.LISTEN]) } as Request,
      response,
      next as unknown as NextFunction
    );
    expect(response.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses an upload from a blocked member", () => {
    const next = vi.fn();
    const response = mockResponse();
    requirePermission(Permission.CONTRIBUTE)(
      { auth: authContext("MEMBER", null, new Date()) } as Request,
      response,
      next as unknown as NextFunction
    );
    expect(response.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("effectivePermissions", () => {
  it("leaves an unblocked membership with exactly what its role grants", () => {
    expect(effectivePermissions({ role: "ADMIN", permissionOverrides: null, uploadsBlockedAt: null } as any))
      .toEqual(permissionsFor("ADMIN"));
  });

  it("takes both contribution permissions from a blocked member", () => {
    const blocked = effectivePermissions({ role: "MEMBER", permissionOverrides: null, uploadsBlockedAt: new Date() } as any);
    expect(blocked).not.toContain(Permission.CONTRIBUTE);
    // Fulfilling a request is an upload, so blocking one without the other
    // would leave the whole point of the block reachable through Requests.
    expect(blocked).not.toContain(Permission.FULFILL_REQUEST);
    expect(blocked).toContain(Permission.LISTEN);
    expect(blocked).toContain(Permission.CREATE_REQUEST);
  });

  it("blocks an owner's uploads too, and leaves the rest of the role alone", () => {
    const blocked = effectivePermissions({ role: "OWNER", permissionOverrides: null, uploadsBlockedAt: new Date() } as any);
    expect(blocked).not.toContain(Permission.CONTRIBUTE);
    expect(blocked).toContain(Permission.MANAGE_LIBRARY);
  });

  it("subtracts from an override list rather than being replaced by it", () => {
    // The block is not a permission snapshot, so it survives whatever else set
    // the overrides and still applies on top of them.
    const blocked = effectivePermissions({
      role: "MEMBER",
      permissionOverrides: [Permission.LISTEN, Permission.CONTRIBUTE],
      uploadsBlockedAt: new Date()
    } as any);
    expect(blocked).toEqual([Permission.LISTEN]);
  });

  it("restores the current role's permissions when the block is lifted", () => {
    // Promoting a blocked member and then unblocking them must grant the new
    // role, not whatever they held when they were blocked.
    expect(effectivePermissions({ role: "ADMIN", permissionOverrides: null, uploadsBlockedAt: null } as any))
      .toContain(Permission.MANAGE_MEMBERS);
  });
});

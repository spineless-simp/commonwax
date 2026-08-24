import { describe, expect, it } from "vitest";
import { can, Permission, permissionsFor } from "./index.js";

describe("role permissions", () => {
  it("lets members listen, contribute, and work with requests", () => {
    expect(can("MEMBER", Permission.LISTEN)).toBe(true);
    expect(can("MEMBER", Permission.FULFILL_REQUEST)).toBe(true);
    expect(can("MEMBER", Permission.REMOVE_MUSIC)).toBe(false);
  });

  it("limits library management to the owner", () => {
    expect(can("ADMIN", Permission.MANAGE_LIBRARY)).toBe(false);
    expect(can("OWNER", Permission.MANAGE_LIBRARY)).toBe(true);
  });

  it("uses an explicit override as the effective permission set", () => {
    expect(permissionsFor("OWNER", [Permission.LISTEN])).toEqual([Permission.LISTEN]);
  });
});

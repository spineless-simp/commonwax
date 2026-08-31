import { beforeEach, describe, expect, it } from "vitest";
import { consume, resetRateLimits } from "./rateLimit.js";

const options = { windowMs: 1000, max: 3 };

describe("consume", () => {
  beforeEach(() => resetRateLimits());

  it("allows requests up to the limit and denies the next one", () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(consume("login", "10.0.0.1", options, 0).allowed).toBe(true);
    }
    expect(consume("login", "10.0.0.1", options, 0).allowed).toBe(false);
  });

  it("counts each caller separately", () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) consume("login", "10.0.0.1", options, 0);
    expect(consume("login", "10.0.0.2", options, 0).allowed).toBe(true);
  });

  it("counts each limiter separately so one endpoint cannot exhaust another", () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) consume("login", "10.0.0.1", options, 0);
    expect(consume("invitations", "10.0.0.1", options, 0).allowed).toBe(true);
  });

  it("starts a fresh window once the previous one has elapsed", () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) consume("login", "10.0.0.1", options, 0);
    expect(consume("login", "10.0.0.1", options, 999).allowed).toBe(false);
    expect(consume("login", "10.0.0.1", options, 1001).allowed).toBe(true);
  });

  it("reports how long the caller must wait", () => {
    consume("login", "10.0.0.1", options, 0);
    expect(consume("login", "10.0.0.1", options, 400).retryAfterSeconds).toBe(1);
  });
});

import type { NextFunction, Request, Response } from "express";

type Window = { count: number; resetAt: number };

export type RateLimitOptions = {
  /** Length of the fixed window, in milliseconds. */
  windowMs: number;
  /** Requests allowed per key per window. */
  max: number;
  /** Distinguishes one limiter's buckets from another's. */
  name: string;
  /** Message returned once the budget is spent. */
  message?: string;
};

const windows = new Map<string, Window>();

function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * Commonwax runs as a single API container behind nginx, so an in-process
 * counter is the honest scope for this limit: it protects the credential
 * endpoints from online guessing without pretending to be a distributed
 * quota. Anything horizontally scaled needs a shared store instead.
 */
export function consume(name: string, identity: string, options: { windowMs: number; max: number }, now = Date.now()): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  // Amortised cleanup: the map only ever holds keys seen in the last window.
  if (windows.size > 5_000) sweep(now);
  const key = `${name}:${identity}`;
  const existing = windows.get(key);
  const window = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + options.windowMs };
  window.count += 1;
  windows.set(key, window);
  return {
    allowed: window.count <= options.max,
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000))
  };
}

export function resetRateLimits(): void {
  windows.clear();
}

/** Identifies the caller for limiting. Requires `trust proxy` so nginx's X-Forwarded-For is honoured. */
function identify(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}

export function rateLimit(options: RateLimitOptions) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const result = consume(options.name, identify(request), options);
    if (result.allowed) return next();
    response.setHeader("Retry-After", String(result.retryAfterSeconds));
    response.status(429).json({ error: options.message ?? "Too many requests. Try again shortly." });
  };
}

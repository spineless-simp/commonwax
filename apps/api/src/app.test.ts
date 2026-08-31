import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * The HTTP surface, exercised over a real socket. These routes had no coverage
 * at all, which is how every upload failure came to answer "Something went
 * wrong" with a 500 while the whole suite stayed green: nothing in it ever
 * asked the app a question over HTTP.
 *
 * Postgres and Navidrome are stubbed rather than started. What is under test is
 * the layer this file owns — who is let through, what status a failure carries,
 * and whether its message survives — not what the database would have said.
 */

const auth = {
  /** Set per test. `null` is an unauthenticated caller. */
  current: null as null | { permissions: string[]; userId: string }
};

vi.mock("@commonwax/db", () => ({
  db: new Proxy({}, {
    get: () => new Proxy(() => undefined, {
      get: () => async () => null,
      apply: async () => null
    })
  }),
  Prisma: {}
}));

vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return {
    ...actual,
    // The real `requirePermission` still runs; only the session lookup that
    // would need a database is replaced.
    authenticate: (request: any, _response: any, next: any) => {
      if (auth.current) {
        request.auth = {
          user: { id: auth.current.userId, displayName: "Test Person" },
          membership: { role: "MEMBER" },
          library: { id: "library-1" },
          permissions: auth.current.permissions
        };
      }
      next();
    }
  };
});

const stageUpload = vi.fn();
const finishImport = vi.fn();

vi.mock("./ingestion.js", async () => {
  const actual = await vi.importActual<typeof import("./ingestion.js")>("./ingestion.js");
  return { ...actual, stageUpload, finishImport };
});

let server: Server;
let origin: string;

beforeAll(async () => {
  const { createApp } = await import("./app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  stageUpload.mockReset();
  finishImport.mockReset();
});

async function send(path: string, init: RequestInit = {}) {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as { error?: string; skipped?: unknown[] } };
}

function audioUpload(name = "track.flac") {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array([1, 2, 3])]), name);
  return form;
}

describe("authentication", () => {
  it("refuses an unauthenticated read", async () => {
    auth.current = null;
    const { status, body } = await send("/api/albums");
    expect(status).toBe(401);
    expect(body.error).toBe("Sign in to continue.");
  });

  it("answers 404 for an unknown /api path rather than falling through to the SPA", async () => {
    auth.current = null;
    const { status } = await send("/api/not-a-route");
    expect(status).toBe(404);
  });
});

describe("permission gating", () => {
  it("refuses a member without the permission the route asks for", async () => {
    auth.current = { userId: "user-1", permissions: ["library:listen"] };
    const { status, body } = await send("/api/uploads", { method: "POST", body: audioUpload() });
    expect(status).toBe(403);
    expect(body.error).toBe("You do not have permission to do that.");
  });

  it("gates refreshing album metadata on contribution, not on listening", async () => {
    auth.current = { userId: "user-1", permissions: ["library:listen"] };
    const { status } = await send("/api/albums/nav.abc/refresh-metadata", { method: "POST" });
    expect(status).toBe(403);
  });

  it("refuses to fulfil a request without the fulfil permission, even with contribute", async () => {
    auth.current = { userId: "user-1", permissions: ["music:contribute"] };
    const form = audioUpload();
    form.append("requestId", "request-1");
    const { status, body } = await send("/api/uploads", { method: "POST", body: form });
    expect(status).toBe(403);
    expect(body.error).toBe("You do not have permission to fulfill requests.");
  });
});

/**
 * The regression this file exists for. Every one of these used to answer 500
 * with "Something went wrong", because the throws carried no status and the
 * error handler will not repeat a 5xx message.
 */
describe("upload failures reach the person holding the files", () => {
  const cases: Array<{ name: string; status: number; message: string }> = [
    { name: "an unreadable file", status: 400, message: "track.flac is not a readable audio file." },
    { name: "an unclaimed request", status: 409, message: "This request must be claimed by you before you fulfill it." },
    { name: "tracks already present", status: 409, message: "All 3 of those tracks are already in the Library." },
    { name: "a scan that ran long", status: 504, message: "Navidrome did not finish scanning within 90 seconds. The files are staged; retry the import." }
  ];

  for (const { name, status, message } of cases) {
    it(`speaks the reason for ${name}`, async () => {
      const { UploadError } = await import("./ingestion.js");
      auth.current = { userId: "user-1", permissions: ["music:contribute"] };
      stageUpload.mockRejectedValueOnce(new UploadError(message, status));
      const response = await send("/api/uploads", { method: "POST", body: audioUpload() });
      expect(response.status).toBe(status);
      expect(response.body.error).toBe(message);
    });
  }

  it("still refuses to repeat the message of a genuine server fault", async () => {
    auth.current = { userId: "user-1", permissions: ["music:contribute"] };
    stageUpload.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.4:5432"));
    const { status, body } = await send("/api/uploads", { method: "POST", body: audioUpload() });
    expect(status).toBe(500);
    expect(body.error).toBe("Something went wrong.");
  });

  it("rejects an unsupported extension before it reaches staging", async () => {
    auth.current = { userId: "user-1", permissions: ["music:contribute"] };
    const { status, body } = await send("/api/uploads", { method: "POST", body: audioUpload("cover.jpg") });
    expect(status).toBe(400);
    expect(body.error).toContain("cover.jpg");
    expect(stageUpload).not.toHaveBeenCalled();
  });

  it("reports the tracks it left out alongside a successful import", async () => {
    auth.current = { userId: "user-1", permissions: ["music:contribute"] };
    const skipped = [{ filename: "02.flac", title: "Ascension Day", artist: "Talk Talk", album: "Laughing Stock" }];
    stageUpload.mockResolvedValueOnce({ batch: { id: "batch-1" }, skipped });
    finishImport.mockResolvedValueOnce({ id: "batch-1", status: "IMPORTED" });
    const { status, body } = await send("/api/uploads", { method: "POST", body: audioUpload() });
    expect(status).toBe(201);
    expect(body.skipped).toEqual(skipped);
  });
});

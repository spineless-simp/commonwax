import { afterEach, describe, expect, it, vi } from "vitest";
import { coverArt, coverArtPath } from "./coverArt.js";

// A 1x1 JPEG: enough leading bytes for the type sniff to recognise it.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function respond(body: Buffer, init: { status?: number } = {}) {
  return new Response(new Uint8Array(body), { status: init.status ?? 200 });
}

afterEach(() => vi.restoreAllMocks());

let seq = 0;
/** A fresh id per test: the module's cache is process-wide by design. */
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

describe("release-group cover art", () => {
  it("serves the archive's bytes from a Commonwax path", () => {
    expect(coverArtPath("abc")).toBe("/api/requests/cover/abc");
  });

  it("sniffs the type rather than trusting the archive", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(PNG));
    expect(await coverArt(id())).toMatchObject({ type: "image/png" });
  });

  it("refuses an SVG, which would carry script from our own origin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(SVG));
    expect(await coverArt(id())).toBeNull();
  });

  it("treats 404 as 'no cover' and caches it", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(Buffer.alloc(0), { status: 404 }));
    const missing = id();
    expect(await coverArt(missing)).toBeNull();
    expect(await coverArt(missing)).toBeNull();
    // The second read is answered from the negative cache: most live sets and
    // compilations have no cover, and a page of results would otherwise ask again.
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("downloads a cover once and serves the rest from cache", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(JPEG));
    const present = id();
    const first = await coverArt(present);
    expect(first).toMatchObject({ type: "image/jpeg" });
    expect(await coverArt(present)).toBe(first);
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent reads of the same cover into one download", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(JPEG));
    const shared = id();
    const [a, b, c] = await Promise.all([coverArt(shared), coverArt(shared), coverArt(shared)]);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("does not cache a network failure, so the next read retries", async () => {
    const failing = id();
    const fetched = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(respond(JPEG));
    await expect(coverArt(failing)).rejects.toThrow("network down");
    expect(await coverArt(failing)).toMatchObject({ type: "image/jpeg" });
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});

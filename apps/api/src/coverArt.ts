import { Buffer } from "node:buffer";
import { sniffImageType } from "./people.js";

/**
 * Release-group covers from the Cover Art Archive, served back from Commonwax's
 * own origin.
 *
 * The browser must not fetch these directly. The deployed CSP is `img-src
 * 'self' data:` (infrastructure/security-headers.conf), so a coverartarchive.org
 * URL in an <img> is blocked outright — and allowing the origin would also tell
 * archive.org what every member's Library is asking for.
 */
const BASE_URL = "https://coverartarchive.org/release-group";
const USER_AGENT = "commonwax/0.0.1 ( https://github.com/commonwax )";

/** front-250 is a thumbnail; anything near this size is not one. */
const MAX_BYTES = 2 * 1024 * 1024;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Misses are cached too, and are the common case: most live sets and
 * compilations have no cover, and a page of 25 results would otherwise ask the
 * archive for all of them again on every render.
 */
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

export type CoverArt = { bytes: Buffer; type: string };

type Entry = { art: CoverArt | null; expiresAt: number };

const cache = new Map<string, Entry>();
// One fetch per release group at a time: a requests page opening in three tabs
// is three readers of one download, not three downloads.
const inFlight = new Map<string, Promise<CoverArt | null>>();

function remember(id: string, art: CoverArt | null): CoverArt | null {
  // Insertion-ordered eviction. The map is small and the cost of dropping a
  // still-warm entry is one refetch, so nothing more clever earns its keep.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(id, { art, expiresAt: Date.now() + (art ? HIT_TTL_MS : MISS_TTL_MS) });
  return art;
}

async function download(id: string): Promise<CoverArt | null> {
  const response = await fetch(`${BASE_URL}/${id}/front-250`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow"
  });
  // 404 is the archive's answer for "no cover", not a failure.
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  // Checked again after reading: the header is the sender's claim about the body.
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  // Sniffed rather than trusted, the same reason avatars and fanart.tv images
  // are: this is served from Commonwax's origin, and an SVG carries script.
  const type = sniffImageType(bytes);
  return type ? { bytes, type } : null;
}

export async function coverArt(releaseGroupId: string): Promise<CoverArt | null> {
  const cached = cache.get(releaseGroupId);
  if (cached && cached.expiresAt > Date.now()) return cached.art;

  const existing = inFlight.get(releaseGroupId);
  if (existing) return existing;

  const pending = download(releaseGroupId)
    .then((art) => remember(releaseGroupId, art))
    // A network failure is not an answer: leave the cache alone so the next
    // read retries rather than serving a miss for the next hour.
    .finally(() => inFlight.delete(releaseGroupId));

  inFlight.set(releaseGroupId, pending);
  return pending;
}

/** Where the browser asks for one release group's cover. */
export const coverArtPath = (releaseGroupId: string) => `/api/requests/cover/${releaseGroupId}`;

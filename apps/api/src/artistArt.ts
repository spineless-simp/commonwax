import { Buffer } from "node:buffer";
import sharp from "sharp";
import { db } from "@commonwax/db";
import { config } from "./config.js";
import { sniffImageType } from "./people.js";
import { normalized } from "./utils.js";

/**
 * Artist logos and backgrounds, from fanart.tv by way of MusicBrainz.
 *
 * This is the only part of Commonwax that reads a service the host does not
 * run, and everything about it is arranged so that the collection does not
 * depend on it. Lookups never happen on the request that renders a page: a
 * browse view reads whatever is already cached and returns, and the names it
 * could not answer for are queued behind it. A page therefore gains artwork on a
 * later visit rather than waiting on a stranger's server for its first.
 *
 * None of it is catalog data. Navidrome still says what music exists; a row in
 * `ArtistArtwork` says only what somebody once drew for a name.
 */

/** Long: an artist who has a logo rarely acquires a different one. */
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Shorter: an artist nobody has drawn for yet may be drawn for. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * MusicBrainz asks for one request per second and a User-Agent that identifies
 * the application. Both are conditions of use rather than suggestions, so the
 * queue below serialises every search and this is the only place that calls it.
 */
const MUSICBRAINZ_INTERVAL_MS = 1100;
const USER_AGENT = "Commonwax/0.0.1 ( https://github.com/commonwax )";

/** Generous for a transparent PNG wordmark, small enough to sit in a row. */
const MAX_LOGO_BYTES = 1024 * 1024;
/** A 1920-wide JPEG background. Above this the row stops being cheap to read. */
const MAX_BACKGROUND_BYTES = 3 * 1024 * 1024;

export type ArtistArtworkView = { logoUrl: string | null; backgroundUrl: string | null };

const NO_ARTWORK: ArtistArtworkView = { logoUrl: null, backgroundUrl: null };

type ArtworkRow = {
  id: string;
  logoType: string | null;
  backgroundType: string | null;
  checkedAt: Date;
  musicBrainzId: string | null;
  updatedAt: Date;
};

/**
 * Served from a route for the same reason avatars are: these are bytes in
 * Postgres, and a list of thirty artists should cost thirty cacheable image
 * requests rather than thirty base64 blobs inside one JSON body. The version is
 * the moment the row last changed, so replacing a logo is never hidden behind
 * the old one's cache entry.
 */
function artworkUrl(row: ArtworkRow, kind: "logo" | "background"): string | null {
  const present = kind === "logo" ? row.logoType : row.backgroundType;
  return present ? `/api/artists/artwork/${row.id}/${kind}?v=${row.updatedAt.valueOf()}` : null;
}

export function artworkView(row: ArtworkRow | undefined): ArtistArtworkView {
  if (!row) return NO_ARTWORK;
  return { logoUrl: artworkUrl(row, "logo"), backgroundUrl: artworkUrl(row, "background") };
}

function stale(row: ArtworkRow, now: number): boolean {
  const age = now - row.checkedAt.valueOf();
  return age > (row.musicBrainzId ? HIT_TTL_MS : MISS_TTL_MS);
}

/**
 * Whatever is cached for these names right now, and nothing else. Callers get an
 * answer in one query; the names with no usable row are handed to the queue so a
 * later read has more to return.
 */
export async function artworkForNames(names: string[]): Promise<Map<string, ArtistArtworkView>> {
  const wanted = new Map<string, string>();
  for (const name of names) {
    const key = normalized(name);
    if (key) wanted.set(key, name);
  }
  if (!wanted.size) return new Map();

  const rows = await db.artistArtwork.findMany({
    where: { nameKey: { in: [...wanted.keys()] } },
    select: { id: true, nameKey: true, logoType: true, backgroundType: true, checkedAt: true, musicBrainzId: true, updatedAt: true }
  });
  const byKey = new Map(rows.map((row) => [row.nameKey, row]));

  const now = Date.now();
  const due = [...wanted].filter(([key]) => {
    const row = byKey.get(key);
    return !row || stale(row, now);
  });
  if (due.length) enqueue(due.map(([, name]) => name));

  return new Map([...wanted].map(([key]) => [key, artworkView(byKey.get(key))]));
}

/** One name's cached artwork. Same rules as the batch; this is the artist page. */
export async function artworkForName(name: string): Promise<ArtistArtworkView> {
  return (await artworkForNames([name])).get(normalized(name)) ?? NO_ARTWORK;
}

/**
 * Crop transparent edges from a PNG so the visible content fills the image
 * frame. JPEG and WebP have no transparency — the buffer passes through.
 */
export async function trimPng(buffer: Buffer, type: string): Promise<Buffer> {
  if (type !== "image/png") return buffer;
  return Buffer.from(await sharp(buffer).trim().toBuffer());
}

// --- Resolution ------------------------------------------------------------

type FanartImage = { url?: string; likes?: string };

/**
 * fanart.tv sorts nothing; the community votes. Taking the most-liked image is
 * the closest thing to "the one people recognise", and it is stable between
 * refreshes in a way that taking the first element is not.
 */
export function bestImage(images: FanartImage[] | undefined): string | null {
  if (!Array.isArray(images) || !images.length) return null;
  const ranked = [...images].sort((left, right) => Number(right.likes ?? 0) - Number(left.likes ?? 0));
  return ranked.find((image) => typeof image.url === "string" && image.url.startsWith("https://"))?.url ?? null;
}

export type MusicBrainzCandidate = { id?: string; name?: string; score?: number };

/**
 * Which of MusicBrainz's candidates is this artist, or none of them.
 *
 * The collection's files are not required to carry artist MBIDs — in practice
 * most do not — so a name search is the only way in. That is a guess, and
 * `catalog.ts` forbids guessing by name when it rebinds media, for a good
 * reason: a wrong match there moves somebody's attribution onto the wrong
 * record. Nothing of the sort is at stake here. The worst outcome of a wrong
 * match is the wrong logo above the right albums, which is a cosmetic error a
 * reader can see and nothing downstream reads. The acceptance is still strict —
 * a perfect score, an exactly equal normalized name, and no second candidate
 * that also matches exactly — because a wrong logo is worth avoiding, not
 * because a right one is load-bearing.
 */
export function pickMusicBrainzMatch(candidates: MusicBrainzCandidate[], name: string): string | null {
  const target = normalized(name);
  const exact = candidates.filter((artist) =>
    artist.id && artist.score === 100 && normalized(artist.name ?? "") === target);
  // Two artists genuinely named the same thing — a real and common case. There
  // is no honest way to pick between them from a name alone, so neither wins.
  return exact.length === 1 ? exact[0]!.id! : null;
}

async function resolveMusicBrainzId(name: string): Promise<string | null> {
  const url = new URL("https://musicbrainz.org/ws/2/artist");
  url.searchParams.set("query", `artist:"${name.replaceAll('"', " ")}"`);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "5");
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`MusicBrainz search returned HTTP ${response.status}`);
  const body = (await response.json()) as { artists?: MusicBrainzCandidate[] };
  return pickMusicBrainzMatch(body.artists ?? [], name);
}

/**
 * The two images fanart.tv has for an artist. `hdmusiclogo` is the transparent
 * wordmark the browse list is built around; `musiclogo` is the older, smaller
 * cut of the same thing and stands in when an artist has only that.
 */
async function fetchFanartArtwork(musicBrainzId: string): Promise<{ logo: string | null; background: string | null }> {
  const url = new URL(`https://webservice.fanart.tv/v3/music/${musicBrainzId}`);
  url.searchParams.set("api_key", config.fanartApiKey);
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  // fanart.tv answers 404 for an artist it has nothing for, which is an answer,
  // not a failure: the row records a miss and stops asking for a week.
  if (response.status === 404) return { logo: null, background: null };
  if (!response.ok) throw new Error(`fanart.tv returned HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, FanartImage[] | undefined>;
  return {
    logo: bestImage(body.hdmusiclogo) ?? bestImage(body.musiclogo),
    background: bestImage(body.artistbackground)
  };
}

/**
 * Bytes for one image, or null. The type is sniffed from the leading bytes and
 * never taken from the Content-Type fanart.tv sent, because these are served
 * back from Commonwax's own origin — the same reason avatars are sniffed. An
 * SVG carries script and is not one of the four raster signatures, so it cannot
 * talk its way through.
 */
async function downloadImage(url: string, maxBytes: number): Promise<{ bytes: Buffer; type: string } | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  // Checked again after reading: the header is the sender's claim about the body.
  if (!bytes.length || bytes.length > maxBytes) return null;
  const type = sniffImageType(bytes);
  return type ? { bytes, type } : null;
}

/**
 * Resolve one artist and write the result, hit or miss. A thrown error leaves
 * the row alone so the next sweep retries; an answered "nothing here" is
 * recorded, because that is the case worth not asking about again.
 */
async function refreshArtist(name: string): Promise<void> {
  const nameKey = normalized(name);
  if (!nameKey) return;

  const musicBrainzId = await resolveMusicBrainzId(name);
  const found = musicBrainzId ? await fetchFanartArtwork(musicBrainzId) : { logo: null, background: null };
  const [rawLogo, background] = await Promise.all([
    found.logo ? downloadImage(found.logo, MAX_LOGO_BYTES) : null,
    found.background ? downloadImage(found.background, MAX_BACKGROUND_BYTES) : null
  ]);
  const logo = rawLogo ? { bytes: await trimPng(rawLogo.bytes, rawLogo.type), type: rawLogo.type } : null;

  const data = {
    name,
    musicBrainzId,
    logo: logo?.bytes ?? null,
    logoType: logo?.type ?? null,
    background: background?.bytes ?? null,
    backgroundType: background?.type ?? null,
    checkedAt: new Date()
  };
  await db.artistArtwork.upsert({ where: { nameKey }, create: { nameKey, ...data }, update: data });
}

// --- The queue -------------------------------------------------------------

const queued = new Set<string>();
let draining: Promise<void> | null = null;

/**
 * Names waiting to be looked up, at MusicBrainz's pace. One drain runs at a
 * time and the set collapses duplicates, so thirty browse loads of the same
 * collection produce one pass over its artists rather than thirty.
 *
 * Nothing awaits this. A failure is logged and the name is dropped for now: the
 * row is left untouched, so the next read finds it stale and queues it again.
 */
export function enqueue(names: string[]): void {
  if (!config.fanartApiKey) return;
  for (const name of names) queued.add(name);
  if (!draining) draining = drain().finally(() => { draining = null; });
}

async function drain(): Promise<void> {
  while (queued.size) {
    const [name] = queued;
    queued.delete(name!);
    // Before the lookup rather than between lookups: a drain that finishes and
    // is restarted by the next page load would otherwise be free to call
    // MusicBrainz twice inside its one-per-second budget.
    await new Promise((settle) => setTimeout(settle, MUSICBRAINZ_INTERVAL_MS));
    try {
      await refreshArtist(name!);
    } catch (error) {
      console.warn(`Artist artwork lookup failed for ${name}:`, error instanceof Error ? error.message : error);
    }
  }
}

export async function artworkBytes(artworkId: string, kind: "logo" | "background") {
  const row = await db.artistArtwork.findUnique({
    where: { id: artworkId },
    select: { logo: true, logoType: true, background: true, backgroundType: true }
  });
  if (!row) return null;
  const bytes = kind === "logo" ? row.logo : row.background;
  const type = kind === "logo" ? row.logoType : row.backgroundType;
  return bytes && type ? { bytes: Buffer.from(bytes), type } : null;
}

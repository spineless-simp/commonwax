import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

type SubsonicEnvelope = {
  "subsonic-response"?: Record<string, any>;
};

export type NavAlbum = {
  id: string;
  name?: string;
  title?: string;
  artist?: string;
  displayArtist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  musicBrainzId?: string;
};

export type NavTrack = {
  id: string;
  title?: string;
  artist?: string;
  displayArtist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  albumArtist?: string;
  albumArtistId?: string;
  coverArt?: string;
  discNumber?: number;
  track?: number;
  duration?: number;
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  path?: string;
  musicBrainzId?: string;
  isrc?: string[] | string;
};

export type NavArtist = {
  id: string;
  name: string;
  albumCount?: number;
  musicBrainzId?: string;
};

export type NavSearchResult = {
  artists: NavArtist[];
  albums: NavAlbum[];
  songs: NavTrack[];
};

export class NavidromeError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "NavidromeError";
  }
}

function authParams(): URLSearchParams {
  const salt = randomBytes(8).toString("hex");
  const token = createHash("md5").update(`${config.navidromePassword}${salt}`).digest("hex");
  return new URLSearchParams({
    u: config.navidromeUsername,
    t: token,
    s: salt,
    v: "1.16.1",
    c: "commonwax",
    f: "json"
  });
}

function endpoint(method: string, params: Record<string, string | number | undefined> = {}): URL {
  const url = new URL(`${config.navidromeUrl}/rest/${method}.view`);
  const query = authParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  url.search = query.toString();
  return url;
}

async function call(method: string, params: Record<string, string | number | undefined> = {}): Promise<Record<string, any>> {
  const response = await fetch(endpoint(method, params), { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new NavidromeError(`Navidrome ${method} returned HTTP ${response.status}`, response.status === 404 ? 70 : undefined);
  }
  const body = (await response.json()) as SubsonicEnvelope;
  const envelope = body["subsonic-response"];
  if (!envelope || envelope.status !== "ok") {
    const message = envelope?.error?.message ?? "Invalid OpenSubsonic response";
    throw new NavidromeError(`Navidrome ${method} failed: ${message}`, Number(envelope?.error?.code) || undefined);
  }
  return envelope;
}

export async function pingNavidrome(): Promise<void> {
  await call("ping");
}

export async function listNavAlbums(type: "alphabeticalByName" | "newest" = "alphabeticalByName", limit?: number): Promise<NavAlbum[]> {
  const albums: NavAlbum[] = [];
  const pageSize = Math.min(500, limit ?? 500);
  for (let offset = 0; ; offset += pageSize) {
    const remaining = limit === undefined ? pageSize : Math.min(pageSize, limit - albums.length);
    if (remaining <= 0) return albums;
    const response = await call("getAlbumList2", { type, size: remaining, offset });
    const page = (response.albumList2?.album ?? []) as NavAlbum[];
    albums.push(...page);
    if (page.length < remaining || (limit !== undefined && albums.length >= limit)) return albums;
  }
}

/**
 * Every browsable surface asks for the whole album list, and the tracks view
 * asks for every song — each one a sequential walk of 500-item pages, and one
 * page load makes several of those requests back to back. Nothing here is a
 * second catalog: it is the same answer Navidrome just gave, held for a few
 * seconds so a single page load does not walk the library once per panel.
 *
 * The window is deliberately short, and `startScan` clears it outright, so the
 * only staleness reachable is a change made directly on disk within the last
 * few seconds — which Navidrome itself would not have indexed yet either.
 */
const CATALOG_CACHE_MS = 15_000;

type CatalogCache<T> = { epoch: number; at: number; value: T } | null;

/**
 * Bumped whenever the catalog is known to have moved under us. A cached walk
 * carries the epoch it was built in, so an entry populated *during* a scan —
 * by some other member's page load while an import waits — is discarded the
 * moment that scan finishes, rather than being served to the import that is
 * about to look for the tracks it just added.
 */
let catalogEpoch = 0;
let scanRunning = false;

let albumCache: CatalogCache<NavAlbum[]> = null;
let albumPending: Promise<NavAlbum[]> | null = null;
let trackCache: CatalogCache<NavTrack[]> = null;
let trackPending: Promise<NavTrack[]> | null = null;

export function invalidateCatalogCache(): void {
  catalogEpoch += 1;
  albumCache = null;
  trackCache = null;
}

function fresh<T>(entry: CatalogCache<T>): entry is { epoch: number; at: number; value: T } {
  return Boolean(entry) && entry!.epoch === catalogEpoch && Date.now() - entry!.at < CATALOG_CACHE_MS;
}

export async function listAllAlbums(): Promise<NavAlbum[]> {
  if (fresh(albumCache)) return albumCache!.value;
  // Concurrent callers share one walk. Without this a single page load starts
  // three or four full traversals against Navidrome at the same moment.
  if (albumPending) return albumPending;
  const epoch = catalogEpoch;
  albumPending = listNavAlbums()
    .then((albums) => {
      albumCache = { epoch, at: Date.now(), value: albums };
      return albums;
    })
    .finally(() => { albumPending = null; });
  return albumPending;
}

export async function searchNavidrome(
  query: string,
  counts: { artistCount?: number; albumCount?: number; songCount?: number; artistOffset?: number; albumOffset?: number; songOffset?: number } = {}
): Promise<NavSearchResult> {
  const response = await call("search3", { query, ...counts });
  const result = response.searchResult3 ?? {};
  return {
    artists: (result.artist ?? []) as NavArtist[],
    albums: (result.album ?? []) as NavAlbum[],
    songs: (result.song ?? []) as NavTrack[]
  };
}

async function walkAllTracks(): Promise<NavTrack[]> {
  const songs: NavTrack[] = [];
  const pageSize = 500;
  for (let songOffset = 0; ; songOffset += pageSize) {
    const result = await searchNavidrome("", { artistCount: 0, albumCount: 0, songCount: pageSize, songOffset });
    songs.push(...result.songs);
    if (result.songs.length < pageSize) return songs;
  }
}

export async function listAllTracks(): Promise<NavTrack[]> {
  if (fresh(trackCache)) return trackCache!.value;
  if (trackPending) return trackPending;
  const epoch = catalogEpoch;
  trackPending = walkAllTracks()
    .then((tracks) => {
      trackCache = { epoch, at: Date.now(), value: tracks };
      return tracks;
    })
    .finally(() => { trackPending = null; });
  return trackPending;
}

export async function getNavAlbum(id: string): Promise<{ album: NavAlbum; songs: NavTrack[] }> {
  const response = await call("getAlbum", { id });
  const album = response.album as NavAlbum & { song?: NavTrack[] };
  if (!album?.id) throw new NavidromeError("Navidrome getAlbum did not return an album.");
  return { album, songs: album?.song ?? [] };
}

export async function findNavAlbum(id: string): Promise<{ album: NavAlbum; songs: NavTrack[] } | null> {
  try {
    return await getNavAlbum(id);
  } catch (error) {
    if (error instanceof NavidromeError && error.code === 70) return null;
    throw error;
  }
}

export async function findNavTrack(id: string): Promise<NavTrack | null> {
  try {
    const response = await call("getSong", { id });
    const song = response.song as NavTrack | undefined;
    return song?.id ? song : null;
  } catch (error) {
    if (error instanceof NavidromeError && error.code === 70) return null;
    throw error;
  }
}

async function nativeToken(): Promise<string> {
  const response = await fetch(`${config.navidromeUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: config.navidromeUsername, password: config.navidromePassword }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new NavidromeError(`Navidrome auth/login returned HTTP ${response.status}`);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new NavidromeError("Navidrome auth/login did not return a session token.");
  return body.token;
}

function libraryRelativePath(path: string, libraryPath?: string): string {
  const clean = path.replaceAll("\\", "/");
  const root = libraryPath?.replaceAll("\\", "/").replace(/\/+$/, "");
  const stripped = root && clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean;
  return stripped.replace(/^\/+/, "");
}

/**
 * OpenSubsonic's `path` on a song is not the file on disk. Navidrome builds it
 * from tags — `albumArtist/album/DD-TT - title.suffix` — so an uploaded
 * `10. God Given.flac` comes back as `01-10 - God Given (Album Version).flac`.
 * Navidrome's own REST API reports the real library-relative path, which is why
 * upload provenance reads it here instead of from `search3`.
 */
export async function listAllSongPaths(): Promise<Map<string, string>> {
  const token = await nativeToken();
  const paths = new Map<string, string>();
  const pageSize = 500;
  for (let start = 0; ; start += pageSize) {
    const url = new URL(`${config.navidromeUrl}/api/song`);
    url.searchParams.set("_start", String(start));
    url.searchParams.set("_end", String(start + pageSize));
    url.searchParams.set("_sort", "path");
    const response = await fetch(url, {
      headers: { "x-nd-authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new NavidromeError(`Navidrome /api/song returned HTTP ${response.status}`);
    const page = (await response.json()) as Array<{ id?: string; path?: string; libraryPath?: string }>;
    for (const song of page) {
      if (song.id && song.path) paths.set(song.id, libraryRelativePath(song.path, song.libraryPath));
    }
    if (page.length < pageSize) return paths;
  }
}

export async function startScan(): Promise<void> {
  // Whatever the scan is about to change, the cached walks describe the library
  // before it. Clearing here rather than on completion means a caller that
  // starts a scan and then reads never sees the pre-scan answer.
  invalidateCatalogCache();
  scanRunning = true;
  await call("startScan");
}

export async function scanStatus(): Promise<{ scanning: boolean; count: number }> {
  const response = await call("getScanStatus");
  const scanning = Boolean(response.scanStatus?.scanning);
  // The catalog has just finished moving. Anything cached while it was in
  // flight describes a library that no longer exists.
  if (scanRunning && !scanning) invalidateCatalogCache();
  scanRunning = scanning;
  return { scanning, count: Number(response.scanStatus?.count ?? 0) };
}

export function mediaUrl(method: "stream" | "getCoverArt", id: string, options: Record<string, string | number> = {}): URL {
  return endpoint(method, { id, ...options });
}

/**
 * Keep transcoded streams chunked. Navidrome's estimated content length can be
 * zero when the source bitrate is unknown, which causes browsers to discard an
 * otherwise valid stream as an empty response.
 */
export function streamMediaUrl(id: string): URL {
  return mediaUrl("stream", id, { format: "mp3" });
}

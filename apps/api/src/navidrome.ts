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
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  created?: string;
};

export type NavTrack = {
  id: string;
  title?: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  coverArt?: string;
  discNumber?: number;
  track?: number;
  duration?: number;
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  path?: string;
};

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
  if (!response.ok) throw new Error(`Navidrome ${method} returned HTTP ${response.status}`);
  const body = (await response.json()) as SubsonicEnvelope;
  const envelope = body["subsonic-response"];
  if (!envelope || envelope.status !== "ok") {
    const message = envelope?.error?.message ?? "Invalid OpenSubsonic response";
    throw new Error(`Navidrome ${method} failed: ${message}`);
  }
  return envelope;
}

export async function pingNavidrome(): Promise<void> {
  await call("ping");
}

export async function listAllAlbums(): Promise<NavAlbum[]> {
  const albums: NavAlbum[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const response = await call("getAlbumList2", { type: "alphabeticalByName", size: pageSize, offset });
    const page = (response.albumList2?.album ?? []) as NavAlbum[];
    albums.push(...page);
    if (page.length < pageSize) return albums;
  }
}

export async function getNavAlbum(id: string): Promise<{ album: NavAlbum; songs: NavTrack[] }> {
  const response = await call("getAlbum", { id });
  const album = response.album as NavAlbum & { song?: NavTrack[] };
  return { album, songs: album?.song ?? [] };
}

export async function startScan(): Promise<void> {
  await call("startScan");
}

export async function scanStatus(): Promise<{ scanning: boolean; count: number }> {
  const response = await call("getScanStatus");
  return { scanning: Boolean(response.scanStatus?.scanning), count: Number(response.scanStatus?.count ?? 0) };
}

export function mediaUrl(method: "stream" | "getCoverArt", id: string, options: Record<string, string | number> = {}): URL {
  return endpoint(method, { id, ...options });
}

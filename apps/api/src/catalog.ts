import { Buffer } from "node:buffer";
import { rmdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  db,
  Prisma,
  type MediaAlbumBinding,
  type MediaTrackBinding
} from "@commonwax/db";
import {
  findNavAlbum,
  findNavTrack,
  getNavAlbum,
  listAllAlbums,
  listAllSongPaths,
  listAllTracks,
  listNavAlbums,
  scanStatus,
  searchNavidrome,
  startScan,
  type NavAlbum,
  type NavArtist,
  type NavTrack
} from "./navidrome.js";
import { artworkForName, artworkForNames } from "./artistArt.js";
import { config } from "./config.js";
import { personSelect, personView, type PersonRow } from "./people.js";
import { insideDirectory, normalized, sleep } from "./utils.js";

type BindingClient = typeof db | Prisma.TransactionClient;

type AlbumBindingState = MediaAlbumBinding & {
  contributions: Array<{
    // Null once the account is erased: the contribution outlives it, so the
    // cover keeps saying where the music came from and stops saying who.
    createdAt: Date;
    contributor: PersonRow | null;
  }>;
  hiddenBy: Array<{ userId: string }>;
  trackBindings: MediaTrackBinding[];
};

const musicBrainzIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

export function durationInSeconds(value: unknown): number {
  const seconds = typeof value === "string" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

export function canonicalMusicBrainzId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLocaleLowerCase();
  return musicBrainzIdPattern.test(id) ? id : null;
}

export function canonicalIsrcs(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(values
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.replace(/[\s-]/g, "").toLocaleUpperCase())
    .filter((candidate) => isrcPattern.test(candidate)))]
    .sort();
}

export function navReference(navidromeId: string): string {
  return `nav.${Buffer.from(navidromeId, "utf8").toString("base64url")}`;
}

export function bindingReference(bindingId: string): string {
  return `binding.${bindingId}`;
}

export function navidromeIdFromReference(reference: string): string | null {
  const encoded = reference.startsWith("nav.") ? reference.slice(4) : "";
  if (!encoded || encoded.length > 1_400 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded && Buffer.byteLength(decoded, "utf8") <= 1_000 ? decoded : null;
  } catch {
    return null;
  }
}

export function bindingIdFromReference(reference: string): string | null {
  const id = reference.startsWith("binding.") ? reference.slice(8) : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function albumTitle(album: NavAlbum): string {
  return album.name?.trim() || album.title?.trim() || "Untitled Album";
}

function albumArtist(album: NavAlbum): string {
  return album.displayArtist?.trim() || album.artist?.trim() || "Unknown Artist";
}

function trackTitle(track: NavTrack): string {
  return track.title?.trim() || "Untitled Track";
}

function trackArtist(track: NavTrack): string {
  return track.displayArtist?.trim() || track.artist?.trim() || "Unknown Artist";
}

function trackAlbumArtist(track: NavTrack, album?: NavAlbum): string {
  return album ? albumArtist(album) : track.albumArtist?.trim() || trackArtist(track);
}

function catalogIncludingAlbum(albums: NavAlbum[], current: NavAlbum): NavAlbum[] {
  let found = false;
  const candidates = albums.map((album) => {
    if (album.id !== current.id) return album;
    found = true;
    return { ...album, ...current };
  });
  return found ? candidates : [...candidates, current];
}

function hasConflictingAlbumIdentity(album: NavAlbum, binding: MediaAlbumBinding): boolean {
  const liveId = canonicalMusicBrainzId(album.musicBrainzId);
  const boundId = canonicalMusicBrainzId(binding.musicBrainzId);
  return Boolean(liveId && boundId && liveId !== boundId);
}

function hasMatchingAlbumIdentity(album: NavAlbum, binding: MediaAlbumBinding): boolean {
  const liveId = canonicalMusicBrainzId(album.musicBrainzId);
  return Boolean(liveId && liveId === canonicalMusicBrainzId(binding.musicBrainzId));
}

/**
 * Match live albums to sparse bindings without using names, years, paths, or
 * ordering as identity. Direct upstream IDs remain valid unless strong identity
 * evidence conflicts; changed IDs rebind only for an unambiguous MusicBrainz match.
 */
export function matchAlbumBindings<T extends MediaAlbumBinding>(
  albums: NavAlbum[],
  bindings: T[]
): Map<string, T> {
  const matches = new Map<string, T>();
  const usedBindings = new Set<string>();
  const byNavidromeId = new Map(bindings.filter((binding) => binding.navidromeId).map((binding) => [binding.navidromeId!, binding]));

  for (const album of albums) {
    const direct = byNavidromeId.get(album.id);
    const externallyClaimed = bindings.some((binding) => binding.id !== direct?.id && hasMatchingAlbumIdentity(album, binding));
    if (direct && !hasConflictingAlbumIdentity(album, direct) &&
      (hasMatchingAlbumIdentity(album, direct) || !externallyClaimed)) {
      matches.set(album.id, direct);
      usedBindings.add(direct.id);
    }
  }

  const liveByMusicBrainzId = new Map<string, NavAlbum[]>();
  for (const album of albums) {
    if (matches.has(album.id)) continue;
    const id = canonicalMusicBrainzId(album.musicBrainzId);
    if (id) liveByMusicBrainzId.set(id, [...(liveByMusicBrainzId.get(id) ?? []), album]);
  }
  const bindingsByMusicBrainzId = new Map<string, T[]>();
  for (const binding of bindings) {
    if (usedBindings.has(binding.id)) continue;
    const id = canonicalMusicBrainzId(binding.musicBrainzId);
    if (id) bindingsByMusicBrainzId.set(id, [...(bindingsByMusicBrainzId.get(id) ?? []), binding]);
  }

  for (const [id, liveCandidates] of liveByMusicBrainzId) {
    const bindingCandidates = bindingsByMusicBrainzId.get(id) ?? [];
    if (liveCandidates.length === 1 && bindingCandidates.length === 1) {
      matches.set(liveCandidates[0].id, bindingCandidates[0]);
    }
  }
  return matches;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasConflictingTrackIdentity(track: NavTrack, binding: MediaTrackBinding): boolean {
  const liveMusicBrainzId = canonicalMusicBrainzId(track.musicBrainzId);
  const boundMusicBrainzId = canonicalMusicBrainzId(binding.musicBrainzId);
  if (liveMusicBrainzId && boundMusicBrainzId) return liveMusicBrainzId !== boundMusicBrainzId;
  const liveIsrcs = canonicalIsrcs(track.isrc);
  const boundIsrcs = canonicalIsrcs(binding.isrcs);
  return liveIsrcs.length > 0 && boundIsrcs.length > 0 && !liveIsrcs.some((isrc) => boundIsrcs.includes(isrc));
}

function hasMatchingTrackIdentity(track: NavTrack, binding: MediaTrackBinding): boolean {
  const liveMusicBrainzId = canonicalMusicBrainzId(track.musicBrainzId);
  if (liveMusicBrainzId && liveMusicBrainzId === canonicalMusicBrainzId(binding.musicBrainzId)) return true;
  const liveIsrcs = canonicalIsrcs(track.isrc);
  const boundIsrcs = canonicalIsrcs(binding.isrcs);
  return liveIsrcs.some((isrc) => boundIsrcs.includes(isrc));
}

export function matchTrackBindings<T extends MediaTrackBinding>(tracks: NavTrack[], bindings: T[]): Map<string, T> {
  const matches = new Map<string, T>();
  const usedBindings = new Set<string>();
  const byNavidromeId = new Map(bindings.filter((binding) => binding.navidromeId).map((binding) => [binding.navidromeId!, binding]));

  for (const track of tracks) {
    const direct = byNavidromeId.get(track.id);
    const externallyClaimed = bindings.some((binding) => binding.id !== direct?.id && hasMatchingTrackIdentity(track, binding));
    if (direct && !hasConflictingTrackIdentity(track, direct) &&
      (hasMatchingTrackIdentity(track, direct) || !externallyClaimed)) {
      matches.set(track.id, direct);
      usedBindings.add(direct.id);
    }
  }

  const liveByMusicBrainzId = new Map<string, NavTrack[]>();
  for (const track of tracks) {
    if (matches.has(track.id)) continue;
    const id = canonicalMusicBrainzId(track.musicBrainzId);
    if (id) liveByMusicBrainzId.set(id, [...(liveByMusicBrainzId.get(id) ?? []), track]);
  }
  const bindingsByMusicBrainzId = new Map<string, T[]>();
  for (const binding of bindings) {
    if (usedBindings.has(binding.id)) continue;
    const id = canonicalMusicBrainzId(binding.musicBrainzId);
    if (id) bindingsByMusicBrainzId.set(id, [...(bindingsByMusicBrainzId.get(id) ?? []), binding]);
  }
  for (const [id, liveCandidates] of liveByMusicBrainzId) {
    const bindingCandidates = bindingsByMusicBrainzId.get(id) ?? [];
    if (liveCandidates.length === 1 && bindingCandidates.length === 1) {
      matches.set(liveCandidates[0].id, bindingCandidates[0]);
      usedBindings.add(bindingCandidates[0].id);
    }
  }

  const candidatesByTrack = new Map<string, T[]>();
  const candidateUseCount = new Map<string, number>();
  for (const track of tracks) {
    if (matches.has(track.id)) continue;
    const isrcs = canonicalIsrcs(track.isrc);
    if (!isrcs.length) continue;
    const candidates = bindings.filter((binding) =>
      !usedBindings.has(binding.id) && !hasConflictingTrackIdentity(track, binding) &&
      canonicalIsrcs(binding.isrcs).some((isrc) => isrcs.includes(isrc))
    );
    candidatesByTrack.set(track.id, candidates);
    for (const candidate of candidates) candidateUseCount.set(candidate.id, (candidateUseCount.get(candidate.id) ?? 0) + 1);
  }
  for (const track of tracks) {
    const candidates = candidatesByTrack.get(track.id) ?? [];
    if (candidates.length === 1 && candidateUseCount.get(candidates[0].id) === 1) {
      matches.set(track.id, candidates[0]);
    }
  }
  return matches;
}

export function matchTrackBinding<T extends MediaTrackBinding>(track: NavTrack, bindings: T[]): T | null {
  return matchTrackBindings([track], bindings).get(track.id) ?? null;
}

function albumBindingData(album: NavAlbum, existing?: MediaAlbumBinding) {
  const duration = durationInSeconds(album.duration) || (existing?.lastKnownDuration ?? null);
  return {
    navidromeId: album.id,
    musicBrainzId: canonicalMusicBrainzId(album.musicBrainzId) ?? existing?.musicBrainzId ?? null,
    lastKnownTitle: albumTitle(album),
    lastKnownArtist: albumArtist(album),
    lastKnownYear: album.year ?? null,
    lastKnownDuration: duration && duration > 0 ? duration : existing?.lastKnownDuration ?? null
  };
}

function trackBindingData(track: NavTrack, albumBindingId: string, existing?: MediaTrackBinding, detectedDuration?: number) {
  const isrcs = canonicalIsrcs(track.isrc);
  const duration = durationInSeconds(track.duration) || detectedDuration || (existing?.lastKnownDuration ?? 0);
  return {
    albumBindingId,
    navidromeId: track.id,
    musicBrainzId: canonicalMusicBrainzId(track.musicBrainzId) ?? existing?.musicBrainzId ?? null,
    isrcs: isrcs.length ? isrcs : existing?.isrcs ?? [],
    lastKnownTitle: trackTitle(track),
    lastKnownArtist: trackArtist(track),
    lastKnownDiscNumber: track.discNumber ?? 1,
    lastKnownTrackNumber: track.track ?? null,
    lastKnownDuration: duration > 0 ? duration : existing?.lastKnownDuration ?? null
  };
}

async function refreshAlbumMatches(libraryId: string, albums: NavAlbum[], matches: Map<string, MediaAlbumBinding>): Promise<void> {
  const changes = albums.flatMap((album) => {
    const binding = matches.get(album.id);
    if (!binding) return [];
    const data = albumBindingData(album, binding);
    const changed = binding.navidromeId !== data.navidromeId || binding.musicBrainzId !== data.musicBrainzId ||
      binding.lastKnownTitle !== data.lastKnownTitle || binding.lastKnownArtist !== data.lastKnownArtist ||
      binding.lastKnownYear !== data.lastKnownYear || binding.lastKnownDuration !== data.lastKnownDuration;
    return changed ? [{ album, binding, data }] : [];
  });
  if (!changes.length) return;

  await db.$transaction(async (tx) => {
    for (const change of changes) {
      if (change.binding.navidromeId !== change.album.id) {
        await tx.mediaAlbumBinding.update({ where: { id: change.binding.id }, data: { navidromeId: null } });
      }
    }
    for (const change of changes) {
      await tx.mediaAlbumBinding.updateMany({
        where: { libraryId, navidromeId: change.album.id, id: { not: change.binding.id } },
        data: { navidromeId: null }
      });
      await tx.mediaAlbumBinding.update({ where: { id: change.binding.id }, data: change.data });
    }
  });
}

async function refreshTrackMatches(
  libraryId: string,
  albumBindingId: string,
  tracks: NavTrack[],
  matches: Map<string, MediaTrackBinding>
): Promise<void> {
  const changes = tracks.flatMap((track) => {
    const binding = matches.get(track.id);
    if (!binding) return [];
    const data = trackBindingData(track, albumBindingId, binding);
    const changed = binding.navidromeId !== data.navidromeId || binding.musicBrainzId !== data.musicBrainzId ||
      !sameStringArray(binding.isrcs, data.isrcs) || binding.lastKnownTitle !== data.lastKnownTitle ||
      binding.lastKnownArtist !== data.lastKnownArtist || binding.lastKnownDiscNumber !== data.lastKnownDiscNumber ||
      binding.lastKnownTrackNumber !== data.lastKnownTrackNumber || binding.lastKnownDuration !== data.lastKnownDuration;
    return changed ? [{ track, binding, data }] : [];
  });
  if (!changes.length) return;

  await db.$transaction(async (tx) => {
    for (const change of changes) {
      if (change.binding.navidromeId !== change.track.id) {
        await tx.mediaTrackBinding.update({ where: { id: change.binding.id }, data: { navidromeId: null } });
      }
    }
    for (const change of changes) {
      await tx.mediaTrackBinding.updateMany({
        where: { libraryId, navidromeId: change.track.id, id: { not: change.binding.id } },
        data: { navidromeId: null }
      });
      await tx.mediaTrackBinding.update({ where: { id: change.binding.id }, data: change.data });
    }
  });
}

async function loadAlbumBindingState(libraryId: string, userId: string): Promise<AlbumBindingState[]> {
  return db.mediaAlbumBinding.findMany({
    where: { libraryId },
    include: {
      hiddenBy: { where: { userId } },
      contributions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { contributor: { select: personSelect } }
      },
      trackBindings: { orderBy: [{ lastKnownDiscNumber: "asc" }, { lastKnownTrackNumber: "asc" }, { lastKnownTitle: "asc" }] }
    }
  });
}

async function resolveAlbumState(
  libraryId: string,
  userId: string,
  albums: NavAlbum[],
  identityAlbums: NavAlbum[] = albums
) {
  const bindings = await loadAlbumBindingState(libraryId, userId);
  const allMatches = matchAlbumBindings(identityAlbums, bindings);
  const matches = new Map(albums.flatMap((album) => {
    const binding = allMatches.get(album.id);
    return binding ? [[album.id, binding] as const] : [];
  }));
  await refreshAlbumMatches(libraryId, albums, matches);
  return { bindings, matches };
}

async function resolveTrackState(
  libraryId: string,
  tracks: NavTrack[],
  albumMatches: Map<string, AlbumBindingState>
): Promise<Map<string, MediaTrackBinding>> {
  const matches = new Map<string, MediaTrackBinding>();
  const tracksByAlbumId = new Map<string, NavTrack[]>();
  for (const track of tracks) {
    if (track.albumId) tracksByAlbumId.set(track.albumId, [...(tracksByAlbumId.get(track.albumId) ?? []), track]);
  }
  for (const [navidromeAlbumId, albumTracks] of tracksByAlbumId) {
    const albumBinding = albumMatches.get(navidromeAlbumId);
    if (!albumBinding?.trackBindings.length) continue;
    const albumTrackMatches = matchTrackBindings(albumTracks, albumBinding.trackBindings);
    await refreshTrackMatches(libraryId, albumBinding.id, albumTracks, albumTrackMatches);
    for (const [navidromeTrackId, binding] of albumTrackMatches) matches.set(navidromeTrackId, binding);
  }
  return matches;
}

/** `identityAlbums` must contain the complete live album candidate set. */
export async function ensureAlbumBinding(
  libraryId: string,
  album: NavAlbum,
  identityAlbums: NavAlbum[],
  client: BindingClient = db
): Promise<MediaAlbumBinding> {
  const bindings = await client.mediaAlbumBinding.findMany({ where: { libraryId } });
  const candidates = catalogIncludingAlbum(identityAlbums, album);
  const match = matchAlbumBindings(candidates, bindings).get(album.id);
  if (match) {
    if (match.navidromeId !== album.id) {
      await client.mediaAlbumBinding.update({ where: { id: match.id }, data: { navidromeId: null } });
    }
    await client.mediaAlbumBinding.updateMany({
      where: { libraryId, navidromeId: album.id, id: { not: match.id } },
      data: { navidromeId: null }
    });
    return client.mediaAlbumBinding.update({ where: { id: match.id }, data: albumBindingData(album, match) });
  }

  const conflictingDirect = bindings.find((binding) => binding.navidromeId === album.id && hasConflictingAlbumIdentity(album, binding));
  if (conflictingDirect) {
    await client.mediaAlbumBinding.update({ where: { id: conflictingDirect.id }, data: { navidromeId: null } });
  }
  return client.mediaAlbumBinding.create({ data: { libraryId, ...albumBindingData(album) } });
}

/** `identityTracks` must contain every live track in the bound album. */
export async function ensureTrackBinding(
  libraryId: string,
  albumBindingId: string,
  track: NavTrack,
  identityTracks: NavTrack[],
  client: BindingClient = db,
  detectedDuration?: number
): Promise<MediaTrackBinding> {
  const bindings = await client.mediaTrackBinding.findMany({ where: { libraryId, albumBindingId } });
  const candidates = identityTracks.some((candidate) => candidate.id === track.id)
    ? identityTracks.map((candidate) => candidate.id === track.id ? { ...candidate, ...track } : candidate)
    : [...identityTracks, track];
  const match = matchTrackBindings(candidates, bindings).get(track.id) ?? null;
  if (match) {
    if (match.navidromeId !== track.id) {
      await client.mediaTrackBinding.update({ where: { id: match.id }, data: { navidromeId: null } });
    }
    await client.mediaTrackBinding.updateMany({
      where: { libraryId, navidromeId: track.id, id: { not: match.id } },
      data: { navidromeId: null }
    });
    return client.mediaTrackBinding.update({ where: { id: match.id }, data: trackBindingData(track, albumBindingId, match, detectedDuration) });
  }

  await client.mediaTrackBinding.updateMany({ where: { libraryId, navidromeId: track.id }, data: { navidromeId: null } });
  return client.mediaTrackBinding.create({ data: { libraryId, ...trackBindingData(track, albumBindingId, undefined, detectedDuration) } });
}

function contributor(binding?: AlbumBindingState) {
  const contribution = binding?.contributions[0];
  // No contribution at all means nobody in Commonwax put this here — music that
  // was on disk before the Library existed. That is a different thing from a
  // contribution whose contributor has been erased, which `personView` renders
  // as the "someone" placeholder rather than as no attribution.
  return contribution ? personView(contribution.contributor) : null;
}

/**
 * Navidrome does not always know how long a track is. Its only metadata reader
 * is TagLib (0.58 registers no other extractor), and TagLib reads no audio
 * properties at all from a fragmented MP4 — `moov` carries `mvhd`/`mdhd`
 * duration 0 and empty sample tables, with the timing living in the `moof`
 * fragments. Every such file scans as `duration 0, bitRate 0, sampleRate 0`,
 * and the album holding it comes back from OpenSubsonic with no `duration`
 * field at all. Verified against Navidrome 0.58.0: ffprobe reports 66.4s for a
 * file `media_file.duration` records as 0.0.
 *
 * The binding's `lastKnownDuration`, read off the file by `music-metadata` at
 * upload, is then the only source there is, so a track falls back to it.
 */
export function trackDuration(track: NavTrack, binding?: MediaTrackBinding): number {
  return durationInSeconds(track.duration) || (binding?.lastKnownDuration ?? 0);
}

/**
 * An album's running time, or null when any part of it is unknown. Summing the
 * tracks that do have a duration would report a running time that is wrong
 * rather than absent, and the frontend already omits a null one.
 */
export function totalDuration(durations: number[], expected: number): number | null {
  if (!durations.length || durations.length !== expected || durations.some((duration) => duration <= 0)) return null;
  return durations.reduce((total, duration) => total + duration, 0);
}

function liveAlbumView(
  album: NavAlbum,
  binding?: AlbumBindingState,
  songs?: NavTrack[],
  trackMatches: Map<string, MediaTrackBinding> = new Map()
) {
  const reference = navReference(album.id);
  const songCount = songs?.length ?? album.songCount ?? 0;
  // Listing surfaces resolve no songs, so there the album's own track bindings
  // stand in for them — the count check is what keeps a half-bound album from
  // reporting the running time of the half.
  const trackDurations = songs
    ? songs.map((song) => trackDuration(song, trackMatches.get(song.id)))
    : (binding?.trackBindings ?? []).map((trackBinding) => trackBinding.lastKnownDuration ?? 0);
  const totalTrackDuration = totalDuration(trackDurations, songCount);
  const tracks = songs ? (() => {
    const liveTracks = songs.map((song) => liveTrackView(song, album, trackMatches.get(song.id)));
    const matchedBindingIds = new Set([...trackMatches.values()].map((trackBinding) => trackBinding.id));
    const unavailableTracks = (binding?.trackBindings ?? [])
      .filter((trackBinding) => !matchedBindingIds.has(trackBinding.id))
      .map((trackBinding) => unavailableTrackView(trackBinding, binding!));
    return [...liveTracks, ...unavailableTracks].sort((left, right) =>
      left.discNumber - right.discNumber || (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER) || left.title.localeCompare(right.title)
    );
  })() : undefined;
  return {
    id: reference,
    bindingId: binding?.id ?? null,
    available: true,
    title: albumTitle(album),
    year: album.year ?? null,
    genre: album.genre ?? null,
    songCount,
    duration: durationInSeconds(album.duration) || totalTrackDuration || binding?.lastKnownDuration || null,
    artist: {
      id: navReference(album.artistId || `name:${normalized(albumArtist(album))}`),
      name: albumArtist(album)
    },
    artworkUrl: album.coverArt ? `/api/albums/${reference}/artwork` : null,
    addedBy: contributor(binding),
    hidden: Boolean(binding?.hiddenBy.length),
    ...(tracks ? { tracks } : {})
  };
}

function liveTrackView(track: NavTrack, album?: NavAlbum, binding?: MediaTrackBinding) {
  const albumId = track.albumId || album?.id;
  const albumReference = albumId ? navReference(albumId) : navReference(`unknown-album:${track.id}`);
  const coverArt = track.coverArt || album?.coverArt;
  const albumArtistName = trackAlbumArtist(track, album);
  return {
    id: navReference(track.id),
    bindingId: binding?.id ?? null,
    available: true,
    title: trackTitle(track),
    discNumber: track.discNumber ?? 1,
    trackNumber: track.track ?? null,
    duration: trackDuration(track, binding) || null,
    suffix: track.suffix ?? null,
    artist: {
      id: navReference(track.artistId || album?.artistId || `name:${normalized(trackArtist(track))}`),
      name: trackArtist(track)
    },
    album: {
      id: albumReference,
      title: track.album?.trim() || (album ? albumTitle(album) : "Unknown Album"),
      artworkUrl: coverArt && albumId ? `/api/albums/${albumReference}/artwork` : null,
      artist: {
        id: navReference(track.albumArtistId || album?.artistId || `name:${normalized(albumArtistName)}`),
        name: albumArtistName
      }
    },
    streamUrl: `/api/tracks/${navReference(track.id)}/stream`
  };
}

function unavailableTrackView(track: MediaTrackBinding, album: MediaAlbumBinding) {
  return {
    id: bindingReference(track.id),
    bindingId: track.id,
    available: false,
    title: track.lastKnownTitle,
    discNumber: track.lastKnownDiscNumber,
    trackNumber: track.lastKnownTrackNumber,
    duration: null,
    suffix: null,
    artist: { id: bindingReference(album.id), name: track.lastKnownArtist },
    album: { id: bindingReference(album.id), title: album.lastKnownTitle, artworkUrl: null, artist: { id: bindingReference(album.id), name: album.lastKnownArtist } },
    streamUrl: null
  };
}

function unavailableAlbumView(binding: AlbumBindingState, withTracks = false) {
  return {
    id: bindingReference(binding.id),
    bindingId: binding.id,
    available: false,
    title: binding.lastKnownTitle,
    year: binding.lastKnownYear,
    genre: null,
    songCount: null,
    duration: null,
    artist: { id: bindingReference(binding.id), name: binding.lastKnownArtist },
    artworkUrl: null,
    addedBy: contributor(binding),
    hidden: Boolean(binding.hiddenBy.length),
    ...(withTracks ? {
      tracks: binding.trackBindings.map((track) => unavailableTrackView(track, binding))
    } : {})
  };
}

/**
 * The public face of a collection, for someone holding a valid invitation who
 * has no account yet. This deliberately reads Navidrome alone: there is no user
 * to resolve per-user hiding against, and counting albums or naming a cover
 * needs no binding state, so the preview stays outside the binding path
 * entirely rather than inventing a userless variant of it.
 */
export async function previewCatalog(coverLimit: number) {
  // Newest for the covers, the full list for the counts — the same two reads
  // the recent-albums view already makes, without the per-user resolution.
  const [newest, all] = await Promise.all([listNavAlbums("newest", coverLimit * 4), listAllAlbums()]);
  return {
    albumCount: all.length,
    trackCount: all.reduce((total, album) => total + (album.songCount ?? 0), 0),
    covers: newest
      .filter((album) => album.coverArt)
      .slice(0, coverLimit)
      .map((album) => ({ id: navReference(album.id), title: albumTitle(album), artist: albumArtist(album) }))
  };
}

/**
 * When each album binding last took a contribution from one person, newest
 * first. Every surface that lists or filters by contributor reads this, so the
 * same name never means two different collections in two places.
 *
 * A record two people both uploaded to counts for both of them, while its cover
 * names only the most recent — the ribbon reports the last contribution, this
 * reports every one.
 */
async function contributionsBy(libraryId: string, contributorId: string): Promise<Map<string, Date>> {
  const contributions = await db.contribution.findMany({
    where: { libraryId, contributorId },
    orderBy: { createdAt: "desc" },
    select: { albumBindingId: true, createdAt: true }
  });
  const contributedAt = new Map<string, Date>();
  for (const row of contributions) if (!contributedAt.has(row.albumBindingId)) contributedAt.set(row.albumBindingId, row.createdAt);
  return contributedAt;
}

type AddedByFilter = (binding?: { id: string }) => boolean;

/**
 * The contributor filter as a predicate over the binding an album resolved to,
 * so every browsable surface applies it the same way and unconditionally — with
 * nobody named, it keeps everything.
 *
 * An album with no binding is nobody's contribution and drops out as soon as a
 * contributor is named: Commonwax attributes music through the contribution it
 * recorded at import, never by guessing from what Navidrome happens to hold.
 */
async function addedByFilter(libraryId: string, contributorId: string | null): Promise<AddedByFilter> {
  if (!contributorId) return () => true;
  const contributed = await contributionsBy(libraryId, contributorId);
  return (binding) => Boolean(binding && contributed.has(binding.id));
}

export async function listCatalogAlbums(libraryId: string, userId: string, hidden = false, addedBy: string | null = null) {
  const [albums, addedByThem] = await Promise.all([listAllAlbums(), addedByFilter(libraryId, addedBy)]);
  const { bindings, matches } = await resolveAlbumState(libraryId, userId, albums);
  const live = albums
    .filter((album) => Boolean(matches.get(album.id)?.hiddenBy.length) === hidden && addedByThem(matches.get(album.id)))
    .map((album) => liveAlbumView(album, matches.get(album.id)));
  if (!hidden) return live.sort((left, right) => left.title.localeCompare(right.title));

  const matchedBindingIds = new Set([...matches.values()].map((binding) => binding.id));
  const unavailable = bindings
    .filter((binding) => binding.hiddenBy.length > 0 && !matchedBindingIds.has(binding.id) && addedByThem(binding))
    .map((binding) => unavailableAlbumView(binding));
  return [...live, ...unavailable].sort((left, right) => left.title.localeCompare(right.title));
}

export async function listRecentCatalogAlbums(libraryId: string, userId: string, addedBy: string | null = null) {
  const [albums, identityAlbums, addedByThem] = await Promise.all([
    listNavAlbums("newest", 100),
    listAllAlbums(),
    addedByFilter(libraryId, addedBy)
  ]);
  const { matches } = await resolveAlbumState(libraryId, userId, albums, identityAlbums);
  // Filtered before the cut, so a contributor's twenty newest are their own
  // twenty rather than whatever survives the whole Library's twenty.
  return albums
    .filter((album) => !matches.get(album.id)?.hiddenBy.length && addedByThem(matches.get(album.id)))
    .slice(0, 20)
    .map((album) => liveAlbumView(album, matches.get(album.id)));
}

async function findLiveAlbumForBinding(libraryId: string, binding: MediaAlbumBinding) {
  if (binding.navidromeId) {
    const [current, bindings] = await Promise.all([
      findNavAlbum(binding.navidromeId),
      db.mediaAlbumBinding.findMany({ where: { libraryId } })
    ]);
    if (current && matchAlbumBindings([current.album], bindings).get(current.album.id)?.id === binding.id) {
      await refreshAlbumMatches(libraryId, [current.album], new Map([[current.album.id, binding]]));
      return current;
    }
  }
  if (!canonicalMusicBrainzId(binding.musicBrainzId)) return null;
  const [albums, bindings] = await Promise.all([
    listAllAlbums(),
    db.mediaAlbumBinding.findMany({ where: { libraryId } })
  ]);
  const matches = matchAlbumBindings(albums, bindings);
  const album = albums.find((candidate) => matches.get(candidate.id)?.id === binding.id);
  if (!album) return null;
  await refreshAlbumMatches(libraryId, [album], new Map([[album.id, binding]]));
  return getNavAlbum(album.id);
}

export async function findLiveAlbumForReference(libraryId: string, reference: string) {
  const navidromeId = navidromeIdFromReference(reference);
  if (navidromeId) return findNavAlbum(navidromeId);
  const bindingId = bindingIdFromReference(reference);
  if (!bindingId) return null;
  const binding = await db.mediaAlbumBinding.findFirst({ where: { id: bindingId, libraryId } });
  return binding ? findLiveAlbumForBinding(libraryId, binding) : null;
}

async function resolveLiveAlbumState(
  libraryId: string,
  userId: string,
  live: { album: NavAlbum; songs: NavTrack[] },
  identityAlbums: NavAlbum[]
) {
  const { matches } = await resolveAlbumState(libraryId, userId, [live.album], identityAlbums);
  const songs = live.songs.map((song) => song.albumId ? song : { ...song, albumId: live.album.id });
  const trackMatches = await resolveTrackState(libraryId, songs, matches);
  return { matches, songs, trackMatches };
}

/** Capture strong IDs and last-known labels only for bindings this live album already resolves to. */
export async function captureLiveBindingSnapshots(
  libraryId: string,
  userId: string,
  live: { album: NavAlbum; songs: NavTrack[] }
): Promise<void> {
  const identityAlbums = catalogIncludingAlbum(await listAllAlbums(), live.album);
  await resolveLiveAlbumState(libraryId, userId, live, identityAlbums);
}

export async function getCatalogAlbum(libraryId: string, userId: string, reference: string) {
  const live = await findLiveAlbumForReference(libraryId, reference);
  if (live) {
    const identityAlbums = navidromeIdFromReference(reference)
      ? catalogIncludingAlbum(await listAllAlbums(), live.album)
      : [live.album];
    const { matches, songs, trackMatches } = await resolveLiveAlbumState(libraryId, userId, live, identityAlbums);
    return liveAlbumView(live.album, matches.get(live.album.id), songs, trackMatches);
  }
  const bindingId = bindingIdFromReference(reference);
  if (!bindingId) return null;
  const binding = (await loadAlbumBindingState(libraryId, userId)).find((candidate) => candidate.id === bindingId);
  return binding ? unavailableAlbumView(binding, true) : null;
}

export async function refreshAlbumMetadata(libraryId: string, userId: string, reference: string) {
  const live = await findLiveAlbumForReference(libraryId, reference);
  if (!live) return null;
  await startScan();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const status = await scanStatus().catch(() => null);
    if (status && !status.scanning) break;
  }
  const fresh = await findNavAlbum(live.album.id);
  if (!fresh) return null;
  const identityAlbums = navidromeIdFromReference(reference)
    ? catalogIncludingAlbum(await listAllAlbums(), fresh.album)
    : [fresh.album];
  const { matches, songs, trackMatches } = await resolveLiveAlbumState(libraryId, userId, fresh, identityAlbums);
  return liveAlbumView(fresh.album, matches.get(fresh.album.id), songs, trackMatches);
}

export async function findAlbumBindingForReference(libraryId: string, reference: string, create: boolean) {
  const bindingId = bindingIdFromReference(reference);
  if (bindingId) return db.mediaAlbumBinding.findFirst({ where: { id: bindingId, libraryId } });
  const navidromeId = navidromeIdFromReference(reference);
  if (!navidromeId) return null;
  const [live, albums] = await Promise.all([findNavAlbum(navidromeId), listAllAlbums()]);
  if (!live) return null;
  const identityAlbums = catalogIncludingAlbum(albums, live.album);
  if (create) return ensureAlbumBinding(libraryId, live.album, identityAlbums);
  const bindings = await db.mediaAlbumBinding.findMany({ where: { libraryId } });
  const match = matchAlbumBindings(identityAlbums, bindings).get(live.album.id);
  await refreshAlbumMatches(
    libraryId,
    [live.album],
    match ? new Map([[live.album.id, match]]) : new Map()
  );
  return match ?? null;
}

/**
 * The albums one member put here, newest contribution first. Availability obeys
 * the same rule as every other album surface: a binding Navidrome can no longer
 * match still appears, because the contribution is Commonwax's own record and
 * outlives the media — but only ever as an unavailable snapshot.
 *
 * `viewerId` is whoever is looking, not whose page this is: hiding is a personal
 * preference, so an album the viewer has hidden stays hidden here too rather
 * than reappearing on somebody else's profile.
 */
export async function listContributedAlbums(libraryId: string, viewerId: string, contributorId: string) {
  const contributedAt = await contributionsBy(libraryId, contributorId);
  if (!contributedAt.size) return [];

  const albums = await listAllAlbums();
  const { bindings, matches } = await resolveAlbumState(libraryId, viewerId, albums);
  const live = albums.flatMap((album) => {
    const binding = matches.get(album.id);
    const at = binding && contributedAt.get(binding.id);
    return at && !binding!.hiddenBy.length ? [{ album: liveAlbumView(album, binding), at }] : [];
  });
  const matchedBindingIds = new Set([...matches.values()].map((binding) => binding.id));
  const unavailable = bindings.flatMap((binding) => {
    const at = contributedAt.get(binding.id);
    return at && !matchedBindingIds.has(binding.id) && !binding.hiddenBy.length
      ? [{ album: unavailableAlbumView(binding), at }]
      : [];
  });
  return [...live, ...unavailable]
    .sort((left, right) => right.at.valueOf() - left.at.valueOf())
    .map((entry) => entry.album);
}

/**
 * The collection's artists, grouped out of its albums rather than read from
 * Navidrome's own artist list. Both would answer, but only this one narrows to
 * the albums the reader may actually see: an artist whose every record is hidden
 * or filtered out is not in the collection being browsed, and would otherwise
 * appear with nothing under them.
 */
function groupArtists(
  albums: NavAlbum[],
  matches: Map<string, AlbumBindingState>,
  addedByThem: (binding: AlbumBindingState | undefined) => boolean
) {
  const grouped = new Map<string, { artist: NavArtist; albums: ReturnType<typeof liveAlbumView>[] }>();
  for (const album of albums) {
    const binding = matches.get(album.id);
    if (binding?.hiddenBy.length || !addedByThem(binding)) continue;
    const name = albumArtist(album);
    const id = album.artistId || `name:${normalized(name)}`;
    const group = grouped.get(id) ?? { artist: { id, name }, albums: [] };
    group.albums.push(liveAlbumView(album, binding));
    grouped.set(id, group);
  }
  return [...grouped.values()]
    .map(({ artist, albums: artistAlbums }) => ({
      id: navReference(artist.id),
      name: artist.name,
      albumCount: artistAlbums.length,
      albums: artistAlbums.sort((left, right) => left.title.localeCompare(right.title))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listCatalogArtists(libraryId: string, userId: string, addedBy: string | null = null) {
  const [albums, addedByThem] = await Promise.all([listAllAlbums(), addedByFilter(libraryId, addedBy)]);
  const { matches } = await resolveAlbumState(libraryId, userId, albums);
  const artists = groupArtists(albums, matches, addedByThem);
  // One query for every artist's cached artwork, and no lookup on this request:
  // whatever is missing is queued and appears on a later read.
  const artwork = await artworkForNames(artists.map((artist) => artist.name));
  return artists.map((artist) => ({ ...artist, ...(artwork.get(normalized(artist.name)) ?? { logoUrl: null, backgroundUrl: null }) }));
}

/**
 * One artist's page. Deliberately the same grouping the list uses, so the album
 * count on a row and the albums behind it can never disagree; the reference is
 * matched against the group ids rather than decoded and trusted, because a
 * `name:` reference means nothing to Navidrome.
 */
export async function getCatalogArtist(libraryId: string, userId: string, artistId: string, addedBy: string | null = null) {
  const [albums, addedByThem] = await Promise.all([listAllAlbums(), addedByFilter(libraryId, addedBy)]);
  const { matches } = await resolveAlbumState(libraryId, userId, albums);
  const artist = groupArtists(albums, matches, addedByThem).find((candidate) => candidate.id === artistId);
  if (!artist) return null;
  return { ...artist, ...(await artworkForName(artist.name)) };
}

export async function listCatalogTracks(libraryId: string, userId: string, addedBy: string | null = null) {
  const [tracks, albums, addedByThem] = await Promise.all([listAllTracks(), listAllAlbums(), addedByFilter(libraryId, addedBy)]);
  const { matches } = await resolveAlbumState(libraryId, userId, albums);
  const trackMatches = await resolveTrackState(libraryId, tracks, matches);
  // A track is added by whoever added its record. Contributions are recorded
  // against the album binding, and the album is what the product attributes on
  // screen, so filtering a track any other way would answer a question no cover
  // in the collection has asked.
  const shownAlbumIds = new Set(albums
    .filter((album) => !matches.get(album.id)?.hiddenBy.length && addedByThem(matches.get(album.id)))
    .map((album) => album.id));
  const albumsById = new Map(albums.map((album) => [album.id, album]));
  return tracks
    .filter((track) => track.albumId ? shownAlbumIds.has(track.albumId) : !addedBy)
    .map((track) => liveTrackView(track, track.albumId ? albumsById.get(track.albumId) : undefined, trackMatches.get(track.id)))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export async function searchCatalog(libraryId: string, userId: string, query: string, addedBy: string | null = null) {
  const [result, allAlbums, addedByThem] = await Promise.all([
    searchNavidrome(query, { artistCount: 20, albumCount: 30, songCount: 50 }),
    listAllAlbums(),
    addedByFilter(libraryId, addedBy)
  ]);
  const { matches } = await resolveAlbumState(libraryId, userId, allAlbums);
  const visibleAlbums = allAlbums.filter((album) => !matches.get(album.id)?.hiddenBy.length && addedByThem(matches.get(album.id)));
  const visibleAlbumIds = new Set(visibleAlbums.map((album) => album.id));
  const allAlbumsById = new Map(allAlbums.map((album) => [album.id, album]));
  const visibleArtistIds = new Set(visibleAlbums.map((album) => album.artistId).filter((id): id is string => Boolean(id)));
  const visibleArtistNames = new Set(visibleAlbums.map((album) => normalized(albumArtist(album))));
  const foundArtists = result.artists
    .filter((artist) => visibleArtistIds.has(artist.id) || visibleArtistNames.has(normalized(artist.name)))
    .map((artist) => ({
      id: navReference(artist.id),
      name: artist.name,
      albumCount: visibleAlbums.filter((album) => album.artistId === artist.id || (!album.artistId && normalized(albumArtist(album)) === normalized(artist.name))).length
    }));
  const artistArtwork = await artworkForNames(foundArtists.map((artist) => artist.name));
  return {
    artists: foundArtists.map((artist) => ({ ...artist, ...(artistArtwork.get(normalized(artist.name)) ?? { logoUrl: null, backgroundUrl: null }) })),
    albums: result.albums
      .filter((album) => visibleAlbumIds.has(album.id))
      .map((album) => liveAlbumView(album, matches.get(album.id))),
    tracks: result.songs
      .filter((track) => track.albumId ? visibleAlbumIds.has(track.albumId) : !addedBy)
      .map((track) => liveTrackView(track, track.albumId ? allAlbumsById.get(track.albumId) : undefined))
  };
}

export async function catalogHasAlbum(artist: string, album: string): Promise<boolean> {
  const albums = await listAllAlbums();
  return albums.some((candidate) =>
    normalized(albumTitle(candidate)) === normalized(album) && normalized(albumArtist(candidate)) === normalized(artist)
  );
}

/**
 * The track titles already sitting under one artist/album name, normalized —
 * empty when nothing in the catalog carries that name.
 *
 * Upload deduplication asks this rather than `catalogHasAlbum` because an album
 * name is not evidence about a particular track: half an album uploaded on
 * Monday must be completable on Tuesday, and two different releases can share
 * a title. Names are the only thing available at staging time — the files have
 * not been scanned yet, so there is no MusicBrainz ID or ISRC to match on — so
 * this is a duplicate filter, never a rebinding, and it never decides identity.
 */
export async function catalogTrackTitles(artist: string, album: string): Promise<Set<string>> {
  const albums = await listAllAlbums();
  const named = albums.filter((candidate) =>
    normalized(albumTitle(candidate)) === normalized(album) && normalized(albumArtist(candidate)) === normalized(artist)
  );
  if (!named.length) return new Set();
  const details = await Promise.all(named.map((candidate) => getNavAlbum(candidate.id)));
  return new Set(details.flatMap((detail) => detail.songs.map((song) => normalized(trackTitle(song)))));
}

export async function resolveAvailableAlbumBindings(libraryId: string, bindings: MediaAlbumBinding[]) {
  if (!bindings.length) return new Map<string, NavAlbum>();
  const [albums, allBindings] = await Promise.all([
    listAllAlbums(),
    db.mediaAlbumBinding.findMany({ where: { libraryId } })
  ]);
  const allMatches = matchAlbumBindings(albums, allBindings);
  const requestedBindingIds = new Set(bindings.map((binding) => binding.id));
  const matches = new Map([...allMatches].filter(([, binding]) => requestedBindingIds.has(binding.id)));
  const matchedAlbums = albums.filter((album) => matches.has(album.id));
  await refreshAlbumMatches(libraryId, matchedAlbums, matches);
  return new Map(albums.flatMap((album) => {
    const binding = matches.get(album.id);
    return binding ? [[binding.id, album] as const] : [];
  }));
}

export type LiveTrackSummary = {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artworkUrl: string | null;
  duration: number | null;
};

/**
 * Compact live descriptions for opaque track references — enough to say what
 * someone is playing without shipping a whole track view. Navidrome stays the
 * only authority: a reference it no longer knows simply resolves to nothing, and
 * a binding reference has no live track to describe at all, so neither is ever
 * dressed up as current catalog data.
 */
export async function describeLiveTracks(references: readonly string[]): Promise<Map<string, LiveTrackSummary>> {
  const navidromeIdByReference = new Map(
    [...new Set(references)].flatMap((reference) => {
      const navidromeId = navidromeIdFromReference(reference);
      return navidromeId ? [[reference, navidromeId] as const] : [];
    })
  );
  const resolved = await Promise.all([...navidromeIdByReference].map(async ([reference, navidromeId]) => {
    // One unreachable or unknown track must not blank out everyone else's.
    const track = await findNavTrack(navidromeId).catch(() => null);
    if (!track) return null;
    const albumId = track.albumId;
    const albumReference = albumId ? navReference(albumId) : null;
    return [reference, {
      id: reference,
      title: trackTitle(track),
      artist: trackArtist(track),
      album: track.album?.trim() || "Unknown Album",
      albumId: albumReference ?? reference,
      artworkUrl: track.coverArt && albumReference ? `/api/albums/${albumReference}/artwork` : null,
      duration: durationInSeconds(track.duration) || null
    }] as const;
  }));
  return new Map(resolved.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}

/**
 * Deletes the files behind live Navidrome songs, and reports how many went.
 *
 * The paths come from `listAllSongPaths` — Navidrome's own REST API — and not
 * from the song objects OpenSubsonic hands back, because those two are not the
 * same thing. OpenSubsonic synthesizes `path` from tags as
 * `albumArtist/album/DD-TT - title.suffix`, so an uploaded `bo-1.flac` is
 * reported as `01 - Myrrhman.flac`: unlinking that path removes nothing, and
 * `ENOENT` is indistinguishable from a file that was already gone. This is the
 * same distinction upload provenance is built on, for the same reason.
 *
 * Emptied directories are pruned up to `MUSIC_DIR`, so removing an album does
 * not leave its artist and album folders behind for the next scan to walk.
 */
export async function deleteSongFiles(songIds: readonly string[]): Promise<number> {
  if (!songIds.length) return 0;
  const paths = await listAllSongPaths();
  const emptied = new Set<string>();
  let removed = 0;
  for (const id of songIds) {
    const relative = paths.get(id);
    if (!relative) continue;
    const target = resolve(config.musicDir, relative);
    if (!insideDirectory(config.musicDir, target)) continue;
    try {
      await unlink(target);
      removed += 1;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    emptied.add(dirname(target));
  }
  for (const directory of emptied) await pruneEmptyDirectories(directory);
  return removed;
}

/** Walks up from a directory removing each one that is now empty, stopping at `MUSIC_DIR`. */
async function pruneEmptyDirectories(directory: string): Promise<void> {
  let current = directory;
  while (insideDirectory(config.musicDir, current) && current !== config.musicDir) {
    try {
      await rmdir(current);
    } catch {
      // Not empty, or already gone. Either way there is nothing above it to prune.
      return;
    }
    current = dirname(current);
  }
}

export function canonicalUploadPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function trackMatchesPendingUploadPath(path: string | undefined, canonicalPaths: Set<string>): boolean {
  return Boolean(path && canonicalPaths.has(canonicalUploadPath(path)));
}

export function sameIsrcs(left: unknown, right: unknown): boolean {
  return sameStringArray(canonicalIsrcs(left), canonicalIsrcs(right));
}

import { db } from "@commonwax/db";
import { getNavAlbum, listAllAlbums, type NavAlbum } from "./navidrome.js";
import { normalized } from "./utils.js";

const concurrency = 6;

async function mapLimit<T, R>(items: T[], mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    })
  );
  return results;
}

function dateOrNull(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export async function syncCatalog(libraryId: string): Promise<void> {
  const navAlbums = await listAllAlbums();
  await mapLimit(navAlbums, (album) => syncAlbum(libraryId, album));
}

async function syncAlbum(libraryId: string, summary: NavAlbum): Promise<void> {
  const { album, songs } = await getNavAlbum(summary.id);
  const artistName = album.artist || summary.artist || songs[0]?.artist || "Unknown Artist";
  const navArtistId = album.artistId || summary.artistId || songs[0]?.artistId || `name:${normalized(artistName)}`;
  const artist = await db.artist.upsert({
    where: { libraryId_navidromeId: { libraryId, navidromeId: navArtistId } },
    create: { libraryId, navidromeId: navArtistId, name: artistName },
    update: { name: artistName }
  });

  const commonAlbum = await db.album.upsert({
    where: { libraryId_navidromeId: { libraryId, navidromeId: album.id } },
    create: {
      libraryId,
      artistId: artist.id,
      navidromeId: album.id,
      title: album.name || album.title || summary.name || summary.title || "Untitled Album",
      year: album.year ?? summary.year,
      genre: album.genre ?? summary.genre,
      songCount: songs.length || album.songCount || summary.songCount || 0,
      duration: album.duration ?? summary.duration ?? songs.reduce((total, song) => total + (song.duration ?? 0), 0),
      coverArt: album.coverArt ?? summary.coverArt,
      navidromeAdded: dateOrNull(album.created ?? summary.created)
    },
    update: {
      artistId: artist.id,
      title: album.name || album.title || summary.name || summary.title || "Untitled Album",
      year: album.year ?? summary.year,
      genre: album.genre ?? summary.genre,
      songCount: songs.length || album.songCount || summary.songCount || 0,
      duration: album.duration ?? summary.duration ?? songs.reduce((total, song) => total + (song.duration ?? 0), 0),
      coverArt: album.coverArt ?? summary.coverArt,
      navidromeAdded: dateOrNull(album.created ?? summary.created)
    }
  });

  for (const song of songs) {
    await db.track.upsert({
      where: { libraryId_navidromeId: { libraryId, navidromeId: song.id } },
      create: {
        libraryId,
        artistId: artist.id,
        albumId: commonAlbum.id,
        navidromeId: song.id,
        title: song.title || "Untitled Track",
        discNumber: song.discNumber ?? 1,
        trackNumber: song.track,
        duration: song.duration ?? 0,
        suffix: song.suffix,
        contentType: song.contentType,
        bitRate: song.bitRate,
        path: song.path
      },
      update: {
        artistId: artist.id,
        albumId: commonAlbum.id,
        title: song.title || "Untitled Track",
        discNumber: song.discNumber ?? 1,
        trackNumber: song.track,
        duration: song.duration ?? 0,
        suffix: song.suffix,
        contentType: song.contentType,
        bitRate: song.bitRate,
        path: song.path
      }
    });
  }
  await db.artist.update({ where: { id: artist.id }, data: { albumCount: { increment: 0 } } });
  const albumCount = await db.album.count({ where: { artistId: artist.id } });
  await db.artist.update({ where: { id: artist.id }, data: { albumCount } });
}

export function albumView(album: any) {
  const contribution = album.contributions?.[0];
  return {
    id: album.id,
    title: album.title,
    year: album.year,
    genre: album.genre,
    songCount: album.songCount,
    duration: album.duration,
    artist: { id: album.artist.id, name: album.artist.name },
    artworkUrl: `/api/albums/${album.id}/artwork`,
    addedAt: contribution?.createdAt ?? album.navidromeAdded ?? album.createdAt,
    addedBy: contribution?.contributor ? { id: contribution.contributor.id, displayName: contribution.contributor.displayName } : null,
    hidden: Boolean(album.hiddenBy?.length)
  };
}

export function trackView(track: any) {
  return {
    id: track.id,
    title: track.title,
    discNumber: track.discNumber,
    trackNumber: track.trackNumber,
    duration: track.duration,
    suffix: track.suffix,
    artist: { id: track.artist.id, name: track.artist.name },
    album: { id: track.album.id, title: track.album.title, artworkUrl: `/api/albums/${track.album.id}/artwork` },
    streamUrl: `/api/tracks/${track.id}/stream`
  };
}

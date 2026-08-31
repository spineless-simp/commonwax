import type { Track } from "./types";

export type TrackSortKey = "title" | "artist" | "album" | "albumArtist" | "format" | "duration";
export type TrackSort = { key: TrackSortKey; direction: "asc" | "desc" };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareText(left: string, right: string) {
  return collator.compare(left, right);
}

function libraryOrder(left: Track, right: Track) {
  return compareText(left.album.artist.name, right.album.artist.name)
    || compareText(left.album.title, right.album.title)
    || left.discNumber - right.discNumber
    || (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.title, right.title);
}

function fieldOrder(left: Track, right: Track, key: TrackSortKey) {
  switch (key) {
    case "title": return compareText(left.title, right.title);
    case "artist": return compareText(left.artist.name, right.artist.name);
    case "album": return compareText(left.album.title, right.album.title);
    case "albumArtist": return compareText(left.album.artist.name, right.album.artist.name) || compareText(left.album.title, right.album.title);
    case "format": return compareText(left.suffix ?? "", right.suffix ?? "");
    case "duration": return (left.duration ?? Number.MAX_SAFE_INTEGER) - (right.duration ?? Number.MAX_SAFE_INTEGER);
  }
}

export function sortTracks(tracks: Track[], sort: TrackSort) {
  return tracks.map((track, index) => ({ track, index })).sort((left, right) => {
    const primary = fieldOrder(left.track, right.track, sort.key) * (sort.direction === "asc" ? 1 : -1);
    return primary || libraryOrder(left.track, right.track) || left.index - right.index;
  }).map(({ track }) => track);
}

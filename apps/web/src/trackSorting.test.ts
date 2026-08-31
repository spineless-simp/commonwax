import { describe, expect, it } from "vitest";
import { sortTracks } from "./trackSorting";
import type { Track } from "./types";

function track(id: string, albumArtist: string, album: string, discNumber: number, trackNumber: number, artist = albumArtist): Track {
  return {
    id,
    bindingId: null,
    available: true,
    title: id,
    discNumber,
    trackNumber,
    duration: 180,
    suffix: "flac",
    artist: { id: `track-${artist}`, name: artist },
    album: { id: `album-${album}`, title: album, artworkUrl: null, artist: { id: `album-artist-${albumArtist}`, name: albumArtist } },
    streamUrl: `/api/tracks/${id}/stream`
  };
}

describe("track sorting", () => {
  it("defaults to album artist, then album, disc, and track order", () => {
    const tracks = [
      track("four", "Zulu", "Second", 1, 1),
      track("three", "Alpha", "Second", 1, 2),
      track("two", "Alpha", "First", 2, 1),
      track("one", "Alpha", "First", 1, 2)
    ];

    expect(sortTracks(tracks, { key: "albumArtist", direction: "asc" }).map(({ id }) => id)).toEqual(["one", "two", "three", "four"]);
  });

  it("uses library order to break ties for another column", () => {
    const tracks = [track("same", "Zulu", "Album", 1, 2), track("same", "Alpha", "Album", 1, 1)];
    expect(sortTracks(tracks, { key: "title", direction: "asc" })[0].album.artist.name).toBe("Alpha");
  });
});

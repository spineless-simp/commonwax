import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaAlbumBinding, MediaTrackBinding } from "@commonwax/db";
import { invalidateCatalogCache } from "./navidrome.js";
import {
  bindingIdFromReference,
  bindingReference,
  canonicalIsrcs,
  canonicalMusicBrainzId,
  durationInSeconds,
  matchAlbumBindings,
  matchTrackBinding,
  matchTrackBindings,
  navidromeIdFromReference,
  navReference,
  previewCatalog,
  sameIsrcs,
  totalDuration,
  trackDuration,
  trackMatchesPendingUploadPath
} from "./catalog.js";

const releaseMbid = "189002e7-3285-4e2e-92a3-7f6c30d407a2";
const otherReleaseMbid = "289002e7-3285-4e2e-92a3-7f6c30d407a2";
const recordingMbid = "389002e7-3285-4e2e-92a3-7f6c30d407a2";

function albumBinding(overrides: Partial<MediaAlbumBinding> = {}): MediaAlbumBinding {
  return {
    id: "binding-a",
    libraryId: "library-a",
    navidromeId: "old-nav-album",
    musicBrainzId: releaseMbid,
    lastKnownTitle: "Last-known title",
    lastKnownArtist: "Last-known artist",
    lastKnownYear: 2001,
    lastKnownDuration: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

function trackBinding(overrides: Partial<MediaTrackBinding> = {}): MediaTrackBinding {
  return {
    id: "track-binding-a",
    libraryId: "library-a",
    albumBindingId: "binding-a",
    navidromeId: "old-nav-track",
    musicBrainzId: recordingMbid,
    isrcs: ["USRC17607839"],
    lastKnownTitle: "Last-known track",
    lastKnownArtist: "Last-known artist",
    lastKnownDiscNumber: 1,
    lastKnownTrackNumber: 1,
    lastKnownDuration: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

describe("catalog durations", () => {
  it("normalizes numeric OpenSubsonic durations", () => {
    expect(durationInSeconds(183.4)).toBe(183);
    expect(durationInSeconds("245")).toBe(245);
    expect(durationInSeconds(0)).toBe(0);
    expect(durationInSeconds(undefined)).toBe(0);
  });

  // Navidrome reads audio properties with TagLib, which returns nothing at all
  // for a fragmented MP4: those files scan as duration 0, and the album holding
  // them comes back with no duration field. The binding is the only other
  // source, and it has one because `music-metadata` read the file on upload.
  it("falls back to the binding when Navidrome reports no track duration", () => {
    const binding = trackBinding({ lastKnownDuration: 362 });
    expect(trackDuration({ id: "t", duration: 0 }, binding)).toBe(362);
    expect(trackDuration({ id: "t" }, binding)).toBe(362);
    expect(trackDuration({ id: "t", duration: 244 }, binding)).toBe(244);
    expect(trackDuration({ id: "t" }, trackBinding())).toBe(0);
    expect(trackDuration({ id: "t" })).toBe(0);
  });

  it("totals an album only when every one of its tracks has a duration", () => {
    expect(totalDuration([315, 243, 362], 3)).toBe(920);
    // A track Navidrome could not measure and no binding covers.
    expect(totalDuration([315, 0, 362], 3)).toBeNull();
    // Fewer bindings than the album has songs: the sum would be a running time
    // that is short rather than missing.
    expect(totalDuration([315, 243], 3)).toBeNull();
    expect(totalDuration([], 0)).toBeNull();
  });
});

describe("opaque live media references", () => {
  it("round-trips arbitrary Navidrome IDs without treating them as Commonwax IDs", () => {
    const upstreamId = "album/id with spaces:and:punctuation";
    expect(navidromeIdFromReference(navReference(upstreamId))).toBe(upstreamId);
    expect(navidromeIdFromReference("binding.189002e7-3285-4e2e-92a3-7f6c30d407a2")).toBeNull();
  });

  it("accepts only explicit UUID binding references", () => {
    const id = "189002e7-3285-4e2e-92a3-7f6c30d407a2";
    expect(bindingIdFromReference(bindingReference(id))).toBe(id);
    expect(bindingIdFromReference("binding.not-a-uuid")).toBeNull();
  });
});

describe("strong external identifiers", () => {
  it("canonicalizes valid MusicBrainz IDs and rejects descriptive values", () => {
    expect(canonicalMusicBrainzId(` ${releaseMbid.toLocaleUpperCase()} `)).toBe(releaseMbid);
    expect(canonicalMusicBrainzId("same album title")).toBeNull();
  });

  it("canonicalizes, validates, deduplicates, and sorts ISRCs", () => {
    expect(canonicalIsrcs(["us-rc1-76-07839", "GBAYE6800011", "USRC17607839", "not-an-isrc"])).toEqual([
      "GBAYE6800011",
      "USRC17607839"
    ]);
    expect(sameIsrcs(["US-RC1-76-07839"], "usrc17607839")).toBe(true);
  });
});

describe("album binding resolution", () => {
  it("uses the current upstream ID even when descriptive metadata changes", () => {
    const binding = albumBinding();
    const matches = matchAlbumBindings([{ id: "old-nav-album", name: "A completely new title", artist: "Renamed artist" }], [binding]);
    expect(matches.get("old-nav-album")).toBe(binding);
  });

  it("rebinds a changed upstream ID through one unambiguous MusicBrainz release ID", () => {
    const binding = albumBinding();
    const matches = matchAlbumBindings([{ id: "new-nav-album", musicBrainzId: releaseMbid }], [binding]);
    expect(matches.get("new-nav-album")).toBe(binding);
  });

  it("does not guess when a MusicBrainz release ID is ambiguous upstream", () => {
    const binding = albumBinding();
    const matches = matchAlbumBindings([
      { id: "new-nav-album-a", musicBrainzId: releaseMbid },
      { id: "new-nav-album-b", musicBrainzId: releaseMbid }
    ], [binding]);
    expect(matches.size).toBe(0);
  });

  it("does not accept a reused upstream ID when strong identities conflict", () => {
    const binding = albumBinding();
    const matches = matchAlbumBindings([{ id: "old-nav-album", musicBrainzId: otherReleaseMbid }], [binding]);
    expect(matches.size).toBe(0);
  });

  it("prefers a unique external identity when an upstream ID points at an unidentified binding", () => {
    const unidentifiedDirect = albumBinding({ id: "binding-direct", musicBrainzId: null });
    const identified = albumBinding({ id: "binding-identified", navidromeId: "another-old-id" });
    const matches = matchAlbumBindings([{ id: "old-nav-album", musicBrainzId: releaseMbid }], [unidentifiedDirect, identified]);
    expect(matches.get("old-nav-album")).toBe(identified);
  });

  it("preserves an unmatched binding as unavailable instead of matching names", () => {
    const binding = albumBinding({ musicBrainzId: null, lastKnownTitle: "Same title", lastKnownArtist: "Same artist" });
    const matches = matchAlbumBindings([{ id: "new-nav-album", name: "Same title", artist: "Same artist" }], [binding]);
    expect(matches.size).toBe(0);
  });
});

describe("track binding resolution", () => {
  it("rebinds within an album through a MusicBrainz recording ID", () => {
    const binding = trackBinding();
    expect(matchTrackBinding({ id: "new-nav-track", musicBrainzId: recordingMbid }, [binding])).toBe(binding);
  });

  it("falls back to one unambiguous ISRC and normalizes its representation", () => {
    const binding = trackBinding({ musicBrainzId: null });
    expect(matchTrackBinding({ id: "new-nav-track", isrc: ["US-RC1-76-07839"] }, [binding])).toBe(binding);
  });

  it("uses a unique ISRC when only the live track has a recording ID", () => {
    const binding = trackBinding({ musicBrainzId: null });
    expect(matchTrackBinding({ id: "new-nav-track", musicBrainzId: recordingMbid, isrc: "USRC17607839" }, [binding])).toBe(binding);
  });

  it("rejects an ISRC match when recording identities conflict", () => {
    const binding = trackBinding();
    expect(matchTrackBinding({ id: "new-nav-track", musicBrainzId: otherReleaseMbid, isrc: "USRC17607839" }, [binding])).toBeNull();
  });

  it("does not guess between multiple bindings with the same recording identifier", () => {
    const first = trackBinding();
    const second = trackBinding({ id: "track-binding-b", navidromeId: "other-old-nav-track" });
    expect(matchTrackBinding({ id: "new-nav-track", musicBrainzId: recordingMbid }, [first, second])).toBeNull();
  });

  it("does not assign one ISRC binding to multiple upstream tracks", () => {
    const binding = trackBinding({ musicBrainzId: null });
    const matches = matchTrackBindings([
      { id: "new-nav-track-a", isrc: ["USRC17607839"] },
      { id: "new-nav-track-b", isrc: ["USRC17607839"] }
    ], [binding]);
    expect(matches.size).toBe(0);
  });

  it("prefers a unique recording identity when an upstream ID points at an unidentified binding", () => {
    const unidentifiedDirect = trackBinding({ id: "track-direct", musicBrainzId: null, isrcs: [] });
    const identified = trackBinding({ id: "track-identified", navidromeId: "another-old-id" });
    expect(matchTrackBinding({ id: "old-nav-track", musicBrainzId: recordingMbid }, [unidentifiedDirect, identified])).toBe(identified);
  });

  it("does not use matching titles or paths as rebinding identity", () => {
    const binding = trackBinding({ musicBrainzId: null, isrcs: [], lastKnownTitle: "Same title" });
    expect(matchTrackBinding({ id: "new-nav-track", title: "Same title", path: "Artist/Album/01.flac" }, [binding])).toBeNull();
  });
});

describe("upload provenance matching", () => {
  it("matches only an exact normalized canonical path", () => {
    const canonicalPaths = new Set(["Artist/Album/01.flac"]);
    expect(trackMatchesPendingUploadPath("Artist\\Album\\01.flac", canonicalPaths)).toBe(true);
    expect(trackMatchesPendingUploadPath("/Artist/Album/01.flac", canonicalPaths)).toBe(true);
    expect(trackMatchesPendingUploadPath("Other/Album/01.flac", canonicalPaths)).toBe(false);
    expect(trackMatchesPendingUploadPath(undefined, canonicalPaths)).toBe(false);
  });

  // Navidrome's OpenSubsonic `path` is built from tags, not from the file on
  // disk, so it can never stand in for upload provenance.
  it("rejects the tag-derived path OpenSubsonic reports for the same file", () => {
    const canonicalPaths = new Set(["Nine Inch Nails/Year Zero/10. God Given.flac"]);
    expect(trackMatchesPendingUploadPath("Nine Inch Nails/Year Zero/01-10 - God Given (Album Version).flac", canonicalPaths)).toBe(false);
  });
});

function albumListEnvelope(albums: Array<Record<string, unknown>>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", albumList2: { album: albums } } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("previewCatalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Newest supplies the covers; the full list supplies the counts. */
  function stubNavidrome(newest: Array<Record<string, unknown>>, all: Array<Record<string, unknown>>) {
    // The album walk is cached in-process for a few seconds, so redefining what
    // Navidrome holds has to say so — otherwise the previous test's collection
    // is still the answer.
    invalidateCatalogCache();
    const seen: Array<{ type: string | null; size: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const type = url.searchParams.get("type");
      seen.push({ type, size: url.searchParams.get("size") });
      return albumListEnvelope(type === "newest" ? newest : all);
    }));
    return seen;
  }

  it("counts the whole collection and takes covers from the newest albums", async () => {
    const seen = stubNavidrome(
      [
        { id: "nav-newest-1", name: "Hex", artist: "Bark Psychosis", coverArt: "art-1" },
        { id: "nav-newest-2", name: "Laughing Stock", artist: "Talk Talk", coverArt: "art-2" }
      ],
      [
        { id: "nav-newest-1", name: "Hex", songCount: 9 },
        { id: "nav-newest-2", name: "Laughing Stock", songCount: 6 },
        { id: "nav-old-3", name: "Spirit of Eden", songCount: 6 }
      ]
    );

    const preview = await previewCatalog(4);

    expect(preview.albumCount).toBe(3);
    expect(preview.trackCount).toBe(21);
    expect(preview.covers).toEqual([
      { id: navReference("nav-newest-1"), title: "Hex", artist: "Bark Psychosis" },
      { id: navReference("nav-newest-2"), title: "Laughing Stock", artist: "Talk Talk" }
    ]);
    // The reference is what the browser gets: never the raw Navidrome id.
    expect(preview.covers[0].id).not.toContain("nav-newest-1");
    expect(seen.some((request) => request.type === "newest")).toBe(true);
  });

  it("skips albums with no artwork and stops at the cover limit", async () => {
    stubNavidrome(
      [
        { id: "nav-1", name: "No art here" },
        { id: "nav-2", name: "Second", coverArt: "art-2" },
        { id: "nav-3", name: "Third", coverArt: "art-3" },
        { id: "nav-4", name: "Fourth", coverArt: "art-4" }
      ],
      [{ id: "nav-1", name: "No art here" }]
    );

    const preview = await previewCatalog(2);

    expect(preview.covers.map((cover) => cover.title)).toEqual(["Second", "Third"]);
  });

  it("treats a missing song count as zero rather than failing the preview", async () => {
    stubNavidrome([], [{ id: "nav-1", name: "Untallied" }, { id: "nav-2", name: "Counted", songCount: 4 }]);

    const preview = await previewCatalog(4);

    expect(preview.albumCount).toBe(2);
    expect(preview.trackCount).toBe(4);
    expect(preview.covers).toEqual([]);
  });
});

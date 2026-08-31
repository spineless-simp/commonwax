import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Upload deduplication. The rule under test is that it is per *track*: an album
 * already in the collection is not evidence about a particular song, so half an
 * album uploaded today has to be completable tomorrow.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function subsonic(payload: Record<string, unknown>) {
  return { ok: true, json: async () => ({ "subsonic-response": { status: "ok", ...payload } }) };
}

type Album = { id: string; name: string; artist: string; songs: string[] };

/** One album-list page, then a `getAlbum` for each album the walk turned up. */
function stubCatalog(albums: Album[]) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("getAlbumList2")) {
      // The walk stops when a page comes back short of the page size.
      return subsonic({ albumList2: { album: url.searchParams.get("offset") === "0" ? albums : [] } });
    }
    if (url.pathname.includes("getAlbum")) {
      const album = albums.find((candidate) => candidate.id === url.searchParams.get("id"))!;
      return subsonic({ album: { ...album, song: album.songs.map((title, index) => ({ id: `${album.id}-${index}`, title })) } });
    }
    throw new Error(`unexpected call to ${url.pathname}`);
  });
}

const laughingStock: Album = {
  id: "album-1",
  name: "Laughing Stock",
  artist: "Talk Talk",
  songs: ["Myrrhman", "Ascension Day", "After the Flood"]
};

async function titles(artist: string, album: string) {
  vi.resetModules();
  const { catalogTrackTitles } = await import("./catalog.js");
  return catalogTrackTitles(artist, album);
}

describe("catalogTrackTitles", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("reports the titles already under that artist and album", async () => {
    stubCatalog([laughingStock]);
    const present = await titles("Talk Talk", "Laughing Stock");
    expect(present.has("myrrhman")).toBe(true);
    expect(present.has("ascension day")).toBe(true);
  });

  it("is empty for an album the catalog does not have, so nothing is skipped", async () => {
    stubCatalog([laughingStock]);
    expect(await titles("Bark Psychosis", "Hex")).toEqual(new Set());
  });

  it("leaves the rest of a part-uploaded album importable", async () => {
    stubCatalog([{ ...laughingStock, songs: ["Myrrhman", "Ascension Day"] }]);
    const present = await titles("Talk Talk", "Laughing Stock");
    // The two that are there are refused; the three that are not can still go in.
    expect(present.has("myrrhman")).toBe(true);
    expect(present.has("after the flood")).toBe(false);
    expect(present.has("new grass")).toBe(false);
  });

  it("matches the album name regardless of case and spacing", async () => {
    stubCatalog([{ ...laughingStock, songs: ["MYRRHMAN"] }]);
    const present = await titles("talk  talk", "LAUGHING STOCK");
    expect(present.has("myrrhman")).toBe(true);
  });

  it("splits a title at a combining mark rather than folding it", async () => {
    // `normalized` decomposes to NFKD and then keeps only letters and digits,
    // so a diacritic becomes a word break. It is shared with rebinding and
    // request matching, so this is pinned here rather than changed: the cost is
    // a duplicate that slips through when two files tag the same title with
    // different accent encodings, which imports one extra track and nothing worse.
    stubCatalog([{ ...laughingStock, songs: ["Après-midi"] }]);
    const present = await titles("Talk Talk", "Laughing Stock");
    expect(present.has("apre s midi")).toBe(true);
  });

  it("pools the tracks of two releases that share a name", async () => {
    stubCatalog([
      { id: "album-1", name: "Greatest Hits", artist: "A Band", songs: ["One"] },
      { id: "album-2", name: "Greatest Hits", artist: "A Band", songs: ["Two"] }
    ]);
    const present = await titles("A Band", "Greatest Hits");
    expect(present).toEqual(new Set(["one", "two"]));
  });
});

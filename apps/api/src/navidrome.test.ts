import { afterEach, describe, expect, it, vi } from "vitest";
import { findNavAlbum, listAllTracks, listNavAlbums, streamMediaUrl } from "./navidrome.js";

function okEnvelope(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...payload } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live Navidrome catalog queries", () => {
  it("does not ask Navidrome to estimate transcoded stream lengths", () => {
    const url = streamMediaUrl("track-with-unknown-source-bitrate");

    expect(url.pathname).toBe("/rest/stream.view");
    expect(url.searchParams.get("id")).toBe("track-with-unknown-source-bitrate");
    expect(url.searchParams.get("format")).toBe("mp3");
    expect(url.searchParams.has("estimateContentLength")).toBe(false);
  });

  it("pages album lists at the OpenSubsonic limit", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      const size = Number(url.searchParams.get("size"));
      expect(url.pathname).toBe("/rest/getAlbumList2.view");
      expect(url.searchParams.get("type")).toBe("alphabeticalByName");
      return okEnvelope({
        albumList2: { album: Array.from({ length: offset === 0 ? size : 1 }, (_, index) => ({ id: `album-${offset + index}` })) }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const albums = await listNavAlbums("alphabeticalByName", 501);
    expect(albums).toHaveLength(501);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses empty-query search paging to read current tracks without a local mirror", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("songOffset"));
      expect(url.pathname).toBe("/rest/search3.view");
      expect(url.searchParams.get("query")).toBe("");
      return okEnvelope({
        searchResult3: { song: Array.from({ length: offset === 0 ? 500 : 1 }, (_, index) => ({ id: `track-${offset + index}` })) }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tracks = await listAllTracks();
    expect(tracks).toHaveLength(501);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats OpenSubsonic missing-data responses as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      "subsonic-response": { status: "failed", error: { code: 70, message: "Not found" } }
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(findNavAlbum("gone")).resolves.toBeNull();
  });
});

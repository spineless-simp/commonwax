import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The catalog walks are cached for a few seconds because every browsable
 * surface asks for the whole album list and the tracks view asks for every
 * song. The cache is only safe if it cannot outlive a scan: an import starts
 * one, waits for it, and then looks for the tracks it just added.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function subsonic(payload: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({ "subsonic-response": { status: "ok", ...payload } })
  };
}

/** One page of albums, then an empty page to end the walk. */
function albumPages(names: string[]) {
  fetchMock.mockResolvedValueOnce(subsonic({
    albumList2: { album: names.map((name, index) => ({ id: `album-${index}`, name })) }
  }));
}

async function loadNavidrome() {
  vi.resetModules();
  fetchMock.mockReset();
  return import("./navidrome.js");
}

function scanning(value: boolean) {
  fetchMock.mockResolvedValueOnce(subsonic({ scanStatus: { scanning: value, count: 0 } }));
}

describe("catalog cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("serves a second read without walking Navidrome again", async () => {
    const nav = await loadNavidrome();
    albumPages(["Hex"]);
    expect(await nav.listAllAlbums()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await nav.listAllAlbums()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent readers into a single walk", async () => {
    const nav = await loadNavidrome();
    albumPages(["Hex"]);
    const [first, second, third] = await Promise.all([
      nav.listAllAlbums(),
      nav.listAllAlbums(),
      nav.listAllAlbums()
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("drops what it holds when a scan starts", async () => {
    const nav = await loadNavidrome();
    albumPages(["Hex"]);
    await nav.listAllAlbums();

    fetchMock.mockResolvedValueOnce(subsonic({}));
    await nav.startScan();

    albumPages(["Hex", "Laughing Stock"]);
    expect(await nav.listAllAlbums()).toHaveLength(2);
  });

  /**
   * The case the epoch exists for. Another member's page load repopulates the
   * cache while an import is waiting on the scan; without the epoch, the import
   * would then be handed that mid-scan snapshot and fail to find its tracks.
   */
  it("discards a read taken while a scan was still running", async () => {
    const nav = await loadNavidrome();

    fetchMock.mockResolvedValueOnce(subsonic({}));
    await nav.startScan();

    // Somebody else browses mid-scan and populates the cache.
    albumPages(["Hex"]);
    expect(await nav.listAllAlbums()).toHaveLength(1);

    scanning(true);
    expect((await nav.scanStatus()).scanning).toBe(true);
    scanning(false);
    expect((await nav.scanStatus()).scanning).toBe(false);

    albumPages(["Hex", "Laughing Stock"]);
    expect(await nav.listAllAlbums()).toHaveLength(2);
  });

  it("keeps serving a read taken after the scan finished", async () => {
    const nav = await loadNavidrome();

    fetchMock.mockResolvedValueOnce(subsonic({}));
    await nav.startScan();
    scanning(false);
    await nav.scanStatus();

    albumPages(["Hex", "Laughing Stock"]);
    expect(await nav.listAllAlbums()).toHaveLength(2);
    const walks = fetchMock.mock.calls.length;
    expect(await nav.listAllAlbums()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(walks);
  });

  it("expires on its own so a change made on disk is not held forever", async () => {
    const nav = await loadNavidrome();
    albumPages(["Hex"]);
    await nav.listAllAlbums();

    vi.useFakeTimers();
    vi.advanceTimersByTime(16_000);

    albumPages(["Hex", "Laughing Stock"]);
    expect(await nav.listAllAlbums()).toHaveLength(2);
  });
});

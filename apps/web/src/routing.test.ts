import { describe, expect, it } from "vitest";
import { HOME, locationFromPath, pathFor, type Location } from "./App";
import type { MusicRequest } from "./types";

/**
 * The address bar is the whole of Back, reload, and "listen to this". Every
 * location the shell can hold has to survive the round trip through a path,
 * and the two that cannot must fail somewhere a reader can follow.
 */

function at(overrides: Partial<Location>): Location {
  return { ...HOME, ...overrides };
}

const albumRef = "nav.NlFoQ1ZFd1pZdGl3enJRYmJSaExQYw";

describe("pathFor", () => {
  it("puts home at the root", () => {
    expect(pathFor(HOME)).toBe("/");
  });

  it("gives every listing view its own path", () => {
    expect(pathFor(at({ view: "albums" }))).toBe("/albums");
    expect(pathFor(at({ view: "activity" }))).toBe("/activity");
    expect(pathFor(at({ view: "admin" }))).toBe("/admin");
    expect(pathFor(at({ view: "settings" }))).toBe("/settings");
  });

  it("addresses a detail page by the thing it shows, not the view behind it", () => {
    expect(pathFor(at({ view: "home", albumId: albumRef }))).toBe(`/albums/${encodeURIComponent(albumRef)}`);
    expect(pathFor(at({ view: "search", artistId: "nav.abc" }))).toBe("/artists/nav.abc");
    expect(pathFor(at({ view: "profile", profileId: "user-1" }))).toBe("/people/user-1");
  });

  it("carries the query so a search can be sent to somebody", () => {
    expect(pathFor(at({ view: "search", query: "talk talk" }))).toBe("/search?q=talk%20talk");
    expect(pathFor(at({ view: "search", query: "" }))).toBe("/search");
  });

  it("distinguishes adding music from fulfilling a request", () => {
    expect(pathFor(at({ uploadRequest: null }))).toBe("/upload");
    expect(pathFor(at({ uploadRequest: { id: "request-1" } as MusicRequest }))).toBe("/upload/request-1");
  });
});

describe("locationFromPath", () => {
  it("round-trips every addressable location", () => {
    const locations = [
      HOME,
      at({ view: "albums" }),
      at({ view: "tracks" }),
      at({ view: "hidden" }),
      at({ view: "library" }),
      at({ view: "settings" }),
      at({ view: "albums", albumId: albumRef }),
      at({ view: "artists", artistId: "nav.abc" }),
      at({ view: "profile", profileId: "user-1" }),
      at({ view: "search", query: "talk talk" }),
      at({ uploadRequest: null })
    ];
    for (const location of locations) {
      const path = pathFor(location);
      const [pathname, search = ""] = path.split("?");
      expect(locationFromPath(pathname, search)).toEqual(location);
    }
  });

  it("decodes a reference that was percent-encoded into the path", () => {
    const awkward = "binding.a b/c";
    const [pathname] = pathFor(at({ albumId: awkward })).split("?");
    expect(locationFromPath(pathname, "").albumId).toBe(awkward);
  });

  it("sends a cold load of a fulfilment upload to where that workflow starts", () => {
    // The request itself has to be read from the API, so the path alone cannot
    // restore the page. Requests is the honest landing place, not a blank upload.
    expect(locationFromPath("/upload/request-1", "")).toEqual(at({ view: "requests" }));
  });

  it("falls back to home for a path the app does not own", () => {
    expect(locationFromPath("/join/some-token", "")).toEqual(HOME);
    expect(locationFromPath("/nonsense", "")).toEqual(HOME);
    expect(locationFromPath("/albums/", "")).toEqual(at({ view: "albums" }));
  });

  it("does not treat a detail segment as a view", () => {
    expect(locationFromPath("/people", "").view).toBe("people");
    expect(locationFromPath("/people/user-1", "").view).toBe("profile");
  });
});

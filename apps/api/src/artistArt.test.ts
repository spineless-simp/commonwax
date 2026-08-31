import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { bestImage, pickMusicBrainzMatch, trimPng } from "./artistArt.js";

const TALK_TALK = "a74f43e4-50c4-4b19-a2ce-c05ce9bccb03";
const OTHER = "26fe16ab-800d-4d91-847e-b3dc7180d5ea";

describe("resolving an artist name to MusicBrainz", () => {
  it("takes the one exact, perfectly scored candidate", () => {
    expect(pickMusicBrainzMatch([
      { id: TALK_TALK, name: "Talk Talk", score: 100 },
      { id: OTHER, name: "TALK TALK TOUCH", score: 69 }
    ], "Talk Talk")).toBe(TALK_TALK);
  });

  it("compares names the way a reader does, not the way MusicBrainz spells them", () => {
    expect(pickMusicBrainzMatch([{ id: TALK_TALK, name: "TALK  TALK", score: 100 }], "Talk Talk")).toBe(TALK_TALK);
  });

  it("refuses a near miss that scored perfectly", () => {
    expect(pickMusicBrainzMatch([{ id: OTHER, name: "Talk Talk Talk", score: 100 }], "Talk Talk")).toBeNull();
  });

  it("refuses a top-scoring candidate that is merely the best of a bad field", () => {
    expect(pickMusicBrainzMatch([{ id: OTHER, name: "Talk Talk", score: 87 }], "Talk Talk")).toBeNull();
  });

  // Two artists really do share a name. Picking either would put one band's
  // lettering over the other's records, so neither gets it.
  it("refuses when two candidates are equally the artist", () => {
    expect(pickMusicBrainzMatch([
      { id: TALK_TALK, name: "Nirvana", score: 100 },
      { id: OTHER, name: "Nirvana", score: 100 }
    ], "Nirvana")).toBeNull();
  });

  it("returns nothing for an artist MusicBrainz has never heard of", () => {
    expect(pickMusicBrainzMatch([], "A Band That Does Not Exist")).toBeNull();
  });
});

describe("choosing an image from fanart.tv", () => {
  it("takes the most-liked image rather than the first one listed", () => {
    expect(bestImage([
      { url: "https://assets.fanart.tv/a.png", likes: "3" },
      { url: "https://assets.fanart.tv/b.png", likes: "11" }
    ])).toBe("https://assets.fanart.tv/b.png");
  });

  // fanart.tv sends likes as strings, so a numeric sort is the only one that
  // ranks 9 below 11.
  it("ranks likes numerically", () => {
    expect(bestImage([
      { url: "https://assets.fanart.tv/nine.png", likes: "9" },
      { url: "https://assets.fanart.tv/eleven.png", likes: "11" }
    ])).toBe("https://assets.fanart.tv/eleven.png");
  });

  it("skips an image served over anything but https", () => {
    expect(bestImage([
      { url: "http://assets.fanart.tv/insecure.png", likes: "40" },
      { url: "https://assets.fanart.tv/secure.png", likes: "1" }
    ])).toBe("https://assets.fanart.tv/secure.png");
  });

  it("has no answer for an image type the artist has none of", () => {
    expect(bestImage(undefined)).toBeNull();
    expect(bestImage([])).toBeNull();
  });
});

describe("trimming transparent edges from a PNG", () => {
  async function transparentPngWithSquare() {
    // 100x100 transparent PNG with a 20x20 opaque white square at (40, 40)
    const canvas = Buffer.alloc(100 * 100 * 4, 0);
    for (let y = 40; y < 60; y++) {
      for (let x = 40; x < 60; x++) {
        const i = (y * 100 + x) * 4;
        canvas[i] = 255; canvas[i + 1] = 255; canvas[i + 2] = 255; canvas[i + 3] = 255;
      }
    }
    return sharp(canvas, { raw: { width: 100, height: 100, channels: 4 } })
      .png()
      .toBuffer();
  }

  it("crops to the bounding box of non-transparent pixels", async () => {
    const input = await transparentPngWithSquare();
    const trimmed = await trimPng(input, "image/png");
    const meta = await sharp(trimmed).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(20);
  });

  it("passes non-PNG buffers through unchanged", async () => {
    const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .jpeg()
      .toBuffer();
    const result = await trimPng(jpeg, "image/jpeg");
    expect(result).toBe(jpeg);
  });
});

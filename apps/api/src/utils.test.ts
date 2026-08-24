import { describe, expect, it } from "vitest";
import { insideDirectory, normalized, safeSegment } from "./utils.js";

describe("ingestion path safety", () => {
  it("sanitizes metadata used as path segments", () => {
    expect(safeSegment("../Slowdive/\0", "Unknown")).toBe(".._Slowdive__");
  });

  it("rejects paths escaping the music root", () => {
    expect(insideDirectory("/music", "/music/Slowdive/song.flac")).toBe(true);
    expect(insideDirectory("/music", "/etc/passwd")).toBe(false);
  });

  it("normalizes request matching", () => {
    expect(normalized("  PJ Harvey — Rid of Me ")).toBe("pj harvey rid of me");
  });
});

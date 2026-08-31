import { describe, expect, it } from "vitest";
import { buildQuery, type MusicBrainzSearchCriteria } from "./musicbrainz.js";

function criteria(fields: Record<string, string | undefined>, ranges: MusicBrainzSearchCriteria["ranges"] = {}): MusicBrainzSearchCriteria {
  return { fields, ranges, limit: 25, offset: 0 };
}

describe("MusicBrainz query building", () => {
  it("quotes values so a multi-word one stays a single clause", () => {
    // Unquoted, `releasegroup:Kid A` is `releasegroup:Kid` plus a free-text `A`.
    expect(buildQuery(criteria({ releasegroup: "Kid A" }))).toBe('releasegroup:"Kid A"');
  });

  it("neutralizes Lucene syntax that appears in real album and artist names", () => {
    expect(buildQuery(criteria({ artist: "Godspeed You! Black Emperor" })))
      .toBe('artist:"Godspeed You! Black Emperor"');
    expect(buildQuery(criteria({ releasegroup: 'He said "no"' })))
      .toBe('releasegroup:"He said \\"no\\""');
    expect(buildQuery(criteria({ releasegroup: "AC\\DC" }))).toBe('releasegroup:"AC\\\\DC"');
  });

  it("ands every filled field together", () => {
    expect(buildQuery(criteria({ releasegroup: "Kid A", artist: "Radiohead", primarytype: "Album" })))
      .toBe('releasegroup:"Kid A" AND artist:"Radiohead" AND primarytype:"Album"');
  });

  it("ignores blank and whitespace-only fields", () => {
    expect(buildQuery(criteria({ releasegroup: "  ", artist: "Radiohead", tag: undefined })))
      .toBe('artist:"Radiohead"');
    expect(buildQuery(criteria({}))).toBe("");
  });

  it("drops enum values the index does not have, rather than searching for them as text", () => {
    expect(buildQuery(criteria({ primarytype: "Bogus" }))).toBe("");
    expect(buildQuery(criteria({ secondarytype: "Mixtape/Street" }))).toBe('secondarytype:"Mixtape/Street"');
  });

  it("drops malformed MBIDs and lowercases valid ones", () => {
    expect(buildQuery(criteria({ arid: "not-a-uuid" }))).toBe("");
    expect(buildQuery(criteria({ arid: "A74B1B7F-71A5-4011-9441-D0B5E4122711" })))
      .toBe("arid:a74b1b7f-71a5-4011-9441-d0b5e4122711");
  });

  it("builds ranges, leaving an omitted bound open", () => {
    expect(buildQuery(criteria({}, { firstreleasedate: { from: "2000", to: "2005" } })))
      .toBe("firstreleasedate:[2000 TO 2005]");
    expect(buildQuery(criteria({}, { firstreleasedate: { from: "2000" } })))
      .toBe("firstreleasedate:[2000 TO *]");
    expect(buildQuery(criteria({}, { releases: { to: "10" } }))).toBe("releases:[* TO 10]");
  });

  it("omits a range with neither bound set", () => {
    expect(buildQuery(criteria({}, { firstreleasedate: { from: "", to: "  " } }))).toBe("");
  });
});

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { ERASED_PERSON, avatarUrl, isReservedDisplayName, personView, sniffImageType } from "./people.js";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(8)]);

describe("sniffImageType", () => {
  it("names the four raster formats from their leading bytes", () => {
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    expect(sniffImageType(gif)).toBe("image/gif");
    expect(sniffImageType(webp)).toBe("image/webp");
  });

  // These are served back from Commonwax's own origin, so anything that is not
  // one of the four formats above must be refused rather than stored and later
  // served as whatever the uploader called it.
  it("refuses SVG, which is markup and carries script", () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', "utf8"))).toBeNull();
  });

  it("refuses HTML that merely claims to be an image", () => {
    expect(sniffImageType(Buffer.from("<!doctype html><script>alert(1)</script>", "utf8"))).toBeNull();
  });

  it("refuses a RIFF container that is not WebP", () => {
    const wav = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1"), Buffer.alloc(8)]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it("refuses anything too short to have a signature", () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(png.subarray(0, 8))).toBeNull();
  });
});

describe("avatarUrl", () => {
  it("is null until a picture has been chosen", () => {
    expect(avatarUrl({ id: "a4e1b0c2-0000-4000-8000-000000000001", avatarUpdatedAt: null })).toBeNull();
  });

  // Without the version, a replaced picture stays hidden behind the cached copy
  // of the old one — the route tells the browser to keep it forever.
  it("versions the URL on the moment the picture was last replaced", () => {
    const avatarUpdatedAt = new Date("2026-08-28T00:00:00.000Z");
    expect(avatarUrl({ id: "a4e1b0c2-0000-4000-8000-000000000001", avatarUpdatedAt }))
      .toBe(`/api/users/a4e1b0c2-0000-4000-8000-000000000001/avatar?v=${avatarUpdatedAt.valueOf()}`);
  });
});

describe("personView", () => {
  it("names a live person and links to their picture", () => {
    const avatarUpdatedAt = new Date("2026-08-28T00:00:00.000Z");
    expect(personView({ id: "a4e1b0c2-0000-4000-8000-000000000001", displayName: "Ida", avatarUpdatedAt }))
      .toEqual({
        id: "a4e1b0c2-0000-4000-8000-000000000001",
        displayName: "Ida",
        avatarUrl: `/api/users/a4e1b0c2-0000-4000-8000-000000000001/avatar?v=${avatarUpdatedAt.valueOf()}`
      });
  });

  // A contribution whose contributor has been erased still has to render. The
  // null id is what every surface reads to stop offering a profile to open.
  it("stands in for an erased account rather than rendering a blank", () => {
    expect(personView(null)).toEqual({ id: null, displayName: "someone", avatarUrl: null });
    expect(personView(undefined)).toEqual({ id: null, displayName: "someone", avatarUrl: null });
  });

  it("hands back a copy, so one surface cannot rename the placeholder for the rest", () => {
    const view = personView(null);
    view.displayName = "nobody";
    expect(personView(null).displayName).toBe("someone");
    expect(ERASED_PERSON.displayName).toBe("someone");
  });
});

describe("isReservedDisplayName", () => {
  // Without this, a member could take the name every erased account wears and
  // collect the credit for music those accounts contributed.
  it("refuses the erased placeholder however it is capitalised or spaced", () => {
    for (const name of ["someone", "Someone", "SOMEONE", "  someone  ", "some one", "some-one", "Some_One"]) {
      expect(isReservedDisplayName(name)).toBe(true);
    }
  });

  it("leaves ordinary names alone, including ones that merely contain it", () => {
    for (const name of ["Ida", "someone else", "Someone Sondheim", "s0meone", "no one"]) {
      expect(isReservedDisplayName(name)).toBe(false);
    }
  });
});

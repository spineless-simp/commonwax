import { Buffer } from "node:buffer";
import { db } from "@commonwax/db";
import { normalized } from "./utils.js";

/**
 * Every place the product names somebody — a contributor ribbon, a request, an
 * activity line, the member list — reads the same three columns, so that adding
 * a picture to one of them added it to all of them rather than to whichever
 * surface was edited next.
 */
export const personSelect = { id: true, displayName: true, avatarUpdatedAt: true } as const;

export type PersonRow = { id: string; displayName: string; avatarUpdatedAt: Date | null };

/**
 * Pictures are served from a route rather than inlined: they are bytes in
 * Postgres, and a member list of twenty people should cost twenty cacheable
 * image requests, not twenty base64 blobs in one JSON body. The URL carries the
 * moment the picture was last replaced so a new one is never hidden behind the
 * old one's cache entry.
 */
export function avatarUrl(person: Pick<PersonRow, "id" | "avatarUpdatedAt">): string | null {
  return person.avatarUpdatedAt ? `/api/users/${person.id}/avatar?v=${person.avatarUpdatedAt.valueOf()}` : null;
}

/**
 * What a contribution, request, or upload reads as once the account behind it
 * has been erased. The record survives — the music still has a provenance — but
 * it no longer names anybody, so the product says so in as many words instead
 * of leaving a blank where a person used to be.
 *
 * `id` is null, which is what every surface keys off to stop offering a profile
 * to open. `RESERVED_DISPLAY_NAMES` below is why a live member can never be
 * mistaken for this one.
 */
export const ERASED_PERSON = { id: null, displayName: "someone", avatarUrl: null } as const;

export type PersonView = { id: string | null; displayName: string; avatarUrl: string | null };

export function personView(person: PersonRow | null | undefined): PersonView {
  if (!person) return { ...ERASED_PERSON };
  return { id: person.id, displayName: person.displayName, avatarUrl: avatarUrl(person) };
}

/**
 * A name compared the way a reader sees it rather than the way Postgres stores
 * it: case-folded, punctuation flattened, and separators removed entirely, so
 * "Someone", "some one", and "Some_One" all collapse to the same string. Longer
 * names survive intact — "someone else" squashes to "someoneelse", not a match.
 */
function squashedName(value: string): string {
  return normalized(value).replace(/\s+/g, "");
}

/**
 * Names nobody may take, because the product already uses them to mean the
 * absence of a person. Without this, a member could adopt the name every erased
 * account wears and take the credit for their music.
 */
const RESERVED_DISPLAY_NAMES = new Set([squashedName(ERASED_PERSON.displayName)]);

export function isReservedDisplayName(value: string): boolean {
  return RESERVED_DISPLAY_NAMES.has(squashedName(value));
}

/**
 * Everyone who has put music in this Library — the names the "added by" filter
 * offers wherever music is browsable.
 *
 * Deliberately not the member list. A contribution is Commonwax's own record and
 * outlives the membership, so someone who has left still names covers in the
 * collection and must stay selectable; a member who has added nothing would
 * only offer an empty answer.
 */
export async function listContributors(libraryId: string) {
  const contributors = await db.contribution.groupBy({
    by: ["contributorId"],
    // Erased accounts are excluded on purpose: the filter names people, and
    // "someone" is the absence of one. Their music stays under "Everyone".
    where: { libraryId, contributorId: { not: null } }
  });
  const ids = contributors.flatMap((row) => row.contributorId ?? []);
  if (!ids.length) return [];
  const people = await db.user.findMany({
    where: { id: { in: ids } },
    select: personSelect,
    orderBy: { displayName: "asc" }
  });
  return people.map(personView);
}

/**
 * Large enough for a photograph off a phone, small enough that a row of them is
 * an ordinary query. There is no image library in this repo, so nothing is
 * re-encoded or resized — the cap is the only thing keeping the column honest.
 */
export const AVATAR_MAX_BYTES = 512 * 1024;

const signatures: ReadonlyArray<readonly [string, (bytes: Buffer) => boolean]> = [
  ["image/png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ["image/gif", (bytes) => bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a"],
  ["image/webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"]
];

/**
 * The stored type comes from the bytes, never from the Content-Type or filename
 * the browser sent. These are served back from Commonwax's own origin, so a file
 * that is really something else — SVG above all, which carries script — must not
 * be able to talk its way into being served as that thing. Anything whose
 * leading bytes are not one of these four raster formats is refused outright.
 */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  return signatures.find(([, matches]) => matches(bytes))?.[0] ?? null;
}

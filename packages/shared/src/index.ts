import type { Permission } from "@commonwax/permissions";

export const REQUEST_STATUSES = ["OPEN", "CLAIMED", "FULFILLED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type Role = (typeof ROLES)[number];

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  libraryId: string;
  libraryName: string;
  role: Role;
  permissions: Permission[];
};

export type ApiError = { error: string; details?: unknown };

export type QueueTrack = {
  id: string;
  title: string;
  artist: { id: string; name: string };
  album: { id: string; title: string; coverUrl?: string };
  duration: number;
};

/**
 * The MusicBrainz release-group search index.
 *
 * Fields and their descriptions come from
 * https://musicbrainz.org/doc/MusicBrainz_API/Search — every field the
 * release-group index accepts is listed here, which is what lets the request
 * composer offer all of them.
 *
 * The list is closed on purpose. The search server does not reject an unknown
 * field name: `notafield:radiohead` returns the same 678 results as a bare
 * `radiohead`, because the parser falls back to a free-text search. A typo
 * would therefore widen a search while looking like it narrowed it, and
 * nothing downstream would report an error. Only send names from this table.
 *
 * `country`, `label`, `format`, `catno`, and `barcode` are release fields, not
 * release-group fields; they appear to work for exactly the reason above.
 */
export const MUSICBRAINZ_PRIMARY_TYPES = ["Album", "Single", "EP", "Broadcast", "Other"] as const;

export const MUSICBRAINZ_SECONDARY_TYPES = [
  "Compilation", "Soundtrack", "Spokenword", "Interview", "Audiobook", "Audio drama",
  "Live", "Remix", "DJ-mix", "Mixtape/Street", "Demo", "Field recording"
] as const;

export const MUSICBRAINZ_RELEASE_STATUSES = [
  "Official", "Promotion", "Bootleg", "Pseudo-Release", "Withdrawn", "Expunged", "Cancelled"
] as const;

export type MusicBrainzFieldKind = "text" | "enum" | "mbid" | "dateRange" | "numberRange";

export type MusicBrainzSearchField = {
  /** The name the search index knows the field by. Sent verbatim as a query parameter. */
  name: string;
  label: string;
  /** MusicBrainz's own description of the field, shown under the input. */
  hint: string;
  kind: MusicBrainzFieldKind;
  /** The only values the index matches, for `enum` fields. */
  options?: readonly string[];
  /** Shown before the composer's filter disclosure is opened. */
  prominent?: boolean;
  group: "Album" | "Artist" | "Type & status" | "Cataloguing" | "Identifiers";
};

export const MUSICBRAINZ_SEARCH_FIELDS: readonly MusicBrainzSearchField[] = [
  { name: "releasegroup", label: "Album", hint: "Part of the album's title; accents are ignored.", kind: "text", prominent: true, group: "Album" },
  { name: "artist", label: "Artist", hint: "Part of the credited artist line, including join phrases like \"feat.\".", kind: "text", prominent: true, group: "Artist" },
  { name: "firstreleasedate", label: "First released", hint: "Year of the earliest release in the group. Either bound may be left blank.", kind: "dateRange", prominent: true, group: "Album" },
  { name: "primarytype", label: "Primary type", hint: "The album's primary type.", kind: "enum", options: MUSICBRAINZ_PRIMARY_TYPES, prominent: true, group: "Type & status" },

  { name: "releasegroupaccent", label: "Album (exact accents)", hint: "Part of the album's title, with the diacritics as written.", kind: "text", group: "Album" },
  { name: "alias", label: "Album alias", hint: "Part of any alias attached to the album; accents are ignored.", kind: "text", group: "Album" },
  { name: "comment", label: "Disambiguation", hint: "Part of the album's disambiguation comment, such as \"deluxe edition\".", kind: "text", group: "Album" },

  { name: "artistname", label: "Artist name", hint: "Part of the name of any one of the album's artists, ignoring how they were credited.", kind: "text", group: "Artist" },
  { name: "creditname", label: "Credited as", hint: "Part of the name an artist was credited under on this album specifically.", kind: "text", group: "Artist" },

  { name: "secondarytype", label: "Secondary type", hint: "Any secondary type, such as a live album or compilation.", kind: "enum", options: MUSICBRAINZ_SECONDARY_TYPES, group: "Type & status" },
  { name: "status", label: "Release status", hint: "The status of any release in the group.", kind: "enum", options: MUSICBRAINZ_RELEASE_STATUSES, group: "Type & status" },
  { name: "type", label: "Legacy type", hint: "The single-value type field that predates albums having several types.", kind: "enum", options: [...MUSICBRAINZ_PRIMARY_TYPES, ...MUSICBRAINZ_SECONDARY_TYPES], group: "Type & status" },

  { name: "release", label: "Release title", hint: "Part of the title of any individual release within the group.", kind: "text", group: "Cataloguing" },
  { name: "releases", label: "Number of releases", hint: "How many releases the group contains. Either bound may be left blank.", kind: "numberRange", group: "Cataloguing" },
  { name: "tag", label: "Tag", hint: "Part of a tag attached to the album, such as a genre.", kind: "text", group: "Cataloguing" },

  { name: "rgid", label: "Release group MBID", hint: "The album's own MusicBrainz identifier.", kind: "mbid", group: "Identifiers" },
  { name: "arid", label: "Artist MBID", hint: "The MusicBrainz identifier of any of the album's artists.", kind: "mbid", group: "Identifiers" },
  { name: "reid", label: "Release MBID", hint: "The MusicBrainz identifier of any release within the group.", kind: "mbid", group: "Identifiers" }
];

export const MUSICBRAINZ_FIELD_GROUPS = ["Album", "Artist", "Type & status", "Cataloguing", "Identifiers"] as const;

/** A range field arrives as two parameters; this is how they are named. */
export const rangeParams = (field: string) => ({ from: `${field}From`, to: `${field}To` });

export type MusicBrainzReleaseGroup = {
  id: string;
  title: string;
  /** The full credited artist line, join phrases included. */
  artist: string;
  artistIds: string[];
  firstReleaseDate: string | null;
  year: number | null;
  primaryType: string | null;
  secondaryTypes: string[];
  disambiguation: string | null;
  releaseCount: number | null;
  /** A Commonwax path, never the archive's own URL — the CSP allows only this origin. */
  coverArtUrl: string;
  /** MusicBrainz's own relevance score, 0–100. */
  score: number;
};

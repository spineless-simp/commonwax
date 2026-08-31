import { MUSICBRAINZ_SEARCH_FIELDS, type MusicBrainzReleaseGroup } from "@commonwax/shared";
import { coverArtPath } from "./coverArt.js";

const BASE_URL = "https://musicbrainz.org/ws/2";
const USER_AGENT = "commonwax/0.0.1 ( https://github.com/commonwax )";

export type MusicBrainzSearchCriteria = {
  /** Keyed by field name; only names in MUSICBRAINZ_SEARCH_FIELDS are read. */
  fields: Record<string, string | undefined>;
  /** Keyed by field name, for `dateRange` and `numberRange` fields. */
  ranges: Record<string, { from?: string; to?: string } | undefined>;
  limit: number;
  offset: number;
};

export type MusicBrainzSearchResult = {
  results: MusicBrainzReleaseGroup[];
  /** Total matches MusicBrainz holds, which is usually more than were returned. */
  total: number;
  offset: number;
  /** The Lucene query that was sent, so the composer can show what it asked. */
  query: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lucene reads `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /` as syntax. Wrapping a
 * value in quotes neutralises all of them except the quote and the backslash,
 * and it is also the only way a multi-word value stays one value: unquoted,
 * `releasegroup:Kid A` parses as `releasegroup:Kid` plus a free-text `A`,
 * which is how a search for an album returns the whole catalogue.
 */
function phrase(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A range bound MusicBrainz understands, or `*` for "unbounded". */
function bound(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? "*" : trimmed;
}

/**
 * Builds the Lucene query. Every clause is ANDed: each field the member fills
 * in should narrow the result set, which is the whole point of the form.
 */
export function buildQuery(criteria: MusicBrainzSearchCriteria): string {
  const clauses: string[] = [];

  for (const field of MUSICBRAINZ_SEARCH_FIELDS) {
    if (field.kind === "dateRange" || field.kind === "numberRange") {
      const range = criteria.ranges[field.name];
      const from = bound(range?.from);
      const to = bound(range?.to);
      if (from === "*" && to === "*") continue;
      clauses.push(`${field.name}:[${from} TO ${to}]`);
      continue;
    }

    const raw = criteria.fields[field.name]?.trim();
    if (!raw) continue;

    if (field.kind === "mbid") {
      // An MBID is a term, not a phrase, and a malformed one would otherwise
      // be quoted and matched literally against nothing.
      if (UUID.test(raw)) clauses.push(`${field.name}:${raw.toLowerCase()}`);
      continue;
    }

    if (field.kind === "enum") {
      // Quoted because several values contain Lucene syntax of their own —
      // "Mixtape/Street" and "DJ-mix" among them.
      if (field.options?.includes(raw)) clauses.push(`${field.name}:${phrase(raw)}`);
      continue;
    }

    clauses.push(`${field.name}:${phrase(raw)}`);
  }

  return clauses.join(" AND ");
}

// In-memory cache with 5-minute TTL, keyed on the built query and the page.
const cache = new Map<string, { data: MusicBrainzSearchResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// MusicBrainz asks for no more than one request per second per client.
let lastRequestAt = 0;
async function rateLimited(): Promise<void> {
  const wait = Math.max(0, 1000 - (Date.now() - lastRequestAt));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// MusicBrainz answers a busy moment with a real 503 and clears within a second
// or two, so retrying is worth more here than surfacing the failure.
async function throttledFetch(url: string, retries = 3): Promise<Response> {
  await rateLimited();
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 503 && retries > 0) {
    const retryAfter = Number(response.headers.get("retry-after")) || 2;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 5) * 1000));
    return throttledFetch(url, retries - 1);
  }
  return response;
}

type RawReleaseGroup = {
  id: string;
  title: string;
  score?: number;
  count?: number;
  disambiguation?: string;
  "first-release-date"?: string;
  "primary-type"?: string;
  "secondary-types"?: string[];
  "artist-credit"?: Array<{ name?: string; joinphrase?: string; artist?: { id?: string; name?: string } }>;
};

/**
 * The credit line is the artists joined by their own join phrases, so
 * "Artist X feat. Y" survives. Reading only the first credit — as this used to
 * — silently drops every collaborator from a split or featured release.
 */
function creditLine(credits: RawReleaseGroup["artist-credit"]): string {
  const line = (credits ?? [])
    .map((credit) => `${credit.name ?? credit.artist?.name ?? ""}${credit.joinphrase ?? ""}`)
    .join("")
    .trim();
  return line || "Unknown artist";
}

function present(raw: RawReleaseGroup): MusicBrainzReleaseGroup {
  const date = raw["first-release-date"] ?? null;
  return {
    id: raw.id,
    title: raw.title,
    artist: creditLine(raw["artist-credit"]),
    artistIds: (raw["artist-credit"] ?? []).map((credit) => credit.artist?.id).filter((id): id is string => Boolean(id)),
    firstReleaseDate: date,
    year: date ? Number(date.slice(0, 4)) || null : null,
    primaryType: raw["primary-type"] ?? null,
    secondaryTypes: raw["secondary-types"] ?? [],
    disambiguation: raw.disambiguation?.trim() || null,
    // `count` on a search hit is the number of releases in the group.
    releaseCount: typeof raw.count === "number" ? raw.count : null,
    coverArtUrl: coverArtPath(raw.id),
    score: typeof raw.score === "number" ? raw.score : 0
  };
}

export async function searchReleaseGroups(criteria: MusicBrainzSearchCriteria): Promise<MusicBrainzSearchResult> {
  const query = buildQuery(criteria);
  if (!query) return { results: [], total: 0, offset: criteria.offset, query };

  const cacheKey = `${criteria.limit}:${criteria.offset}:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = `${BASE_URL}/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=${criteria.limit}&offset=${criteria.offset}`;
  const response = await throttledFetch(url);
  if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`);
  const body = await response.json() as { count?: number; "release-groups"?: RawReleaseGroup[] };

  const result: MusicBrainzSearchResult = {
    results: (body["release-groups"] ?? []).map(present),
    total: body.count ?? 0,
    offset: criteria.offset,
    query
  };

  cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

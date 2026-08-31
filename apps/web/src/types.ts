import type { MusicBrainzReleaseGroup, Role, SessionUser } from "@commonwax/shared";

export type { Role, SessionUser };

/**
 * Everything someone holding a valid invitation may see before they have an
 * account: who invited them, how big the collection is, and a few of its
 * covers. `catalog` is null when Navidrome could not answer — the invitation is
 * still acceptable without it.
 */
export type InvitationPreview = {
  libraryName: string;
  invitedBy: string;
  expiresAt: string;
  library: { memberCount: number; createdAt: string };
  catalog: {
    albumCount: number;
    trackCount: number;
    covers: Array<{ id: string; title: string; artist: string; artworkUrl: string }>;
  } | null;
};

/**
 * Everyone the product names. `avatarUrl` is null until they choose a picture.
 *
 * `id` is null for one person only: the placeholder an erased account leaves
 * behind, named "someone", whose contributions are still in the collection and
 * whose profile no longer exists. Anywhere a name opens a page, a null id is
 * what stops it being a link.
 */
export type Person = { id: string | null; displayName: string; avatarUrl: string | null };
export type Member = {
  id: string;
  role: Role;
  joinedAt: string;
  /** Their role still grants contributing; an admin has withheld it. */
  uploadsBlocked: boolean;
  user: Person & { id: string; email: string };
};
/** What the admin panel may offer here, asked rather than assumed. */
export type AdminCapabilities = { services: string[]; serviceControl: boolean; canReset: boolean };
export type RestartResult = { restarted: string[]; failed: Array<{ service: string; error: string }> };
/**
 * One member's page. `email` is present only on your own — the API withholds
 * everybody else's — and `self` is what the page keys its editing off.
 */
export type Profile = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  self: boolean;
  role: Role;
  joinedAt: string;
  contributions: number;
  listening: Listening | null;
  activity: Activity[];
};
/**
 * `logoUrl` and `backgroundUrl` come from fanart.tv by way of the API, and are
 * null far more often than not: for an artist nobody has drawn, for a collection
 * whose host set no fanart.tv key, and for the first read after new music lands,
 * because the lookup happens behind the response rather than inside it. Every
 * surface that shows one has to read as finished without it.
 */
export type Artist = { id: string; name: string; albumCount: number; logoUrl: string | null; backgroundUrl: string | null; albums?: Album[] };
export type Album = {
  id: string;
  bindingId: string | null;
  available: boolean;
  title: string;
  year?: number | null;
  genre?: string | null;
  songCount: number | null;
  duration: number | null;
  artist: { id: string; name: string };
  artworkUrl: string | null;
  addedBy: Person | null;
  hidden: boolean;
  tracks?: Track[];
};
export type Track = {
  id: string;
  bindingId: string | null;
  available: boolean;
  title: string;
  discNumber: number;
  trackNumber?: number | null;
  duration: number | null;
  suffix?: string | null;
  artist: { id: string; name: string };
  album: { id: string; title: string; artworkUrl: string | null; artist: { id: string; name: string } };
  streamUrl: string | null;
};
export type MusicRequest = {
  id: string;
  artist: string;
  album: string;
  musicBrainzReleaseGroupId?: string | null;
  coverArtUrl?: string | null;
  year?: number | null;
  status: "OPEN" | "CLAIMED" | "FULFILLED";
  createdAt: string;
  requester: Person;
  claimant?: Person | null;
  fulfiller?: Person | null;
  fulfilledAlbum?: { id: string; title: string; available: boolean } | null;
};

export type { MusicBrainzReleaseGroup } from "@commonwax/shared";

/** One page of release-group matches, as `/api/requests/search` returns it. */
export type MusicBrainzSearchResult = {
  results: MusicBrainzReleaseGroup[];
  total: number;
  offset: number;
  query: string;
};
/** What a member is playing right now, resolved live from Navidrome on read. */
export type Listening = {
  track: {
    id: string;
    title: string;
    artist: string;
    album: string;
    albumId: string;
    artworkUrl: string | null;
    duration: number | null;
  };
  since: string;
};
export type LibraryOverview = {
  library: { name: string; createdAt: string; memberCount: number; contributionCount: number };
  members: Array<{
    id: string;
    role: Role;
    joinedAt: string;
    user: Person;
    contributions: number;
    listening: Listening | null;
    activity: Activity[];
  }>;
};
export type Activity = {
  id: string;
  type: "MUSIC_ADDED" | "MEMBER_JOINED" | "REQUEST_CREATED" | "REQUEST_CLAIMED" | "REQUEST_FULFILLED";
  createdAt: string;
  /** Display name of whoever acted — recorded at the time, so it outlives them. */
  actor: string | null;
  /** Null once they have left: their name stays, their profile stops existing. */
  actorId: string | null;
  actorAvatarUrl: string | null;
  album?: string;
  artist?: string;
  requester?: string;
  mediaAvailable?: boolean;
  mediaId?: string | null;
};

/** A file the import left out because that track was already in the collection. */
export type SkippedFile = { filename: string; title: string; artist: string; album: string };

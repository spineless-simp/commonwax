import type { SessionUser } from "@commonwax/shared";

export type { SessionUser };

export type Person = { id: string; displayName: string };
export type Artist = { id: string; name: string; albumCount: number; albums?: Album[] };
export type Album = {
  id: string;
  title: string;
  year?: number | null;
  genre?: string | null;
  songCount: number;
  duration: number;
  artist: { id: string; name: string };
  artworkUrl: string;
  addedAt: string;
  addedBy: Person | null;
  hidden: boolean;
  tracks?: Track[];
};
export type Track = {
  id: string;
  title: string;
  discNumber: number;
  trackNumber?: number | null;
  duration: number;
  suffix?: string | null;
  artist: { id: string; name: string };
  album: { id: string; title: string; artworkUrl: string };
  streamUrl: string;
};
export type MusicRequest = {
  id: string;
  artist: string;
  album: string;
  status: "OPEN" | "CLAIMED" | "FULFILLED" | "CANCELLED";
  createdAt: string;
  requester: Person;
  claimant?: Person | null;
  fulfiller?: Person | null;
  fulfilledAlbum?: { id: string; title: string } | null;
};
export type Activity = {
  id: string;
  type: "MUSIC_ADDED" | "MEMBER_JOINED" | "REQUEST_CREATED" | "REQUEST_CLAIMED" | "REQUEST_FULFILLED";
  createdAt: string;
  actor: Person | null;
  album?: string;
  artist?: string;
  requester?: string;
};

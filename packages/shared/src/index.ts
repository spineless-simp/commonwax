export const REQUEST_STATUSES = ["OPEN", "CLAIMED", "FULFILLED", "CANCELLED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type Role = (typeof ROLES)[number];

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  libraryId: string;
  libraryName: string;
  role: Role;
  permissions: string[];
};

export type ApiError = { error: string; details?: unknown };

export type QueueTrack = {
  id: string;
  title: string;
  artist: { id: string; name: string };
  album: { id: string; title: string; coverUrl?: string };
  duration: number;
};

import { db } from "@commonwax/db";
import { activityView } from "./activity.js";
import { describeLiveTracks } from "./catalog.js";
import { personSelect, personView } from "./people.js";

/**
 * A presence row is a heartbeat, not a claim. The web player refreshes it while
 * audio is genuinely playing, so a row older than this window belongs to someone
 * who closed the tab or lost their connection — not to a current listener.
 */
export const LISTENING_WINDOW_MS = 120_000;

/** How many of a member's own events the overview shows beside them. */
export const ACTIVITY_PER_MEMBER = 3;

/** How far back the overview reads the feed to find those events. */
const ACTIVITY_SCAN_LIMIT = 400;

export function listeningCutoff(now: Date = new Date()): Date {
  return new Date(now.valueOf() - LISTENING_WINDOW_MS);
}

export function isListeningFresh(updatedAt: Date, now: Date = new Date()): boolean {
  return updatedAt.valueOf() > listeningCutoff(now).valueOf();
}

/**
 * Slice one descending feed into per-actor runs. Reading the feed once and
 * bucketing it keeps this to a single query no matter how many members there
 * are, and each member keeps the feed's ordering.
 */
export function groupByActor<T extends { actorId: string | null }>(
  events: readonly T[],
  perActor: number
): Map<string, T[]> {
  const byActor = new Map<string, T[]>();
  for (const event of events) {
    if (!event.actorId) continue;
    const existing = byActor.get(event.actorId);
    if (!existing) byActor.set(event.actorId, [event]);
    else if (existing.length < perActor) existing.push(event);
  }
  return byActor;
}

/**
 * Everything the library overview shows about who runs this server and who is in
 * it. Listening presence is resolved through Navidrome at read time so it obeys
 * the same rule as the rest of the catalog: a track Navidrome no longer has is
 * simply not reported, never served from a stale local copy.
 */
export async function buildLibraryOverview(libraryId: string) {
  const [library, memberships, events, contributionCounts, presence] = await Promise.all([
    db.library.findUnique({ where: { id: libraryId } }),
    db.membership.findMany({
      where: { libraryId },
      include: { user: { select: personSelect } },
      orderBy: { joinedAt: "asc" }
    }),
    db.activityEvent.findMany({
      where: { libraryId },
      include: { actor: { select: personSelect } },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_SCAN_LIMIT
    }),
    db.contribution.groupBy({ by: ["contributorId"], where: { libraryId }, _count: { _all: true } }),
    db.listeningNow.findMany({ where: { libraryId, updatedAt: { gt: listeningCutoff() } } })
  ]);
  if (!library) return null;

  const activityByActor = groupByActor(events, ACTIVITY_PER_MEMBER);
  const contributionsByUser = new Map(contributionCounts.map((row) => [row.contributorId, row._count._all]));
  const memberIds = new Set(memberships.map((membership) => membership.userId));
  // A row can outlive its membership by up to the presence window.
  const current = presence.filter((row) => memberIds.has(row.userId));
  const tracks = await describeLiveTracks(current.map((row) => row.trackReference));
  const listeningByUser = new Map(current.flatMap((row) => {
    const track = tracks.get(row.trackReference);
    return track ? [[row.userId, { track, since: row.startedAt }] as const] : [];
  }));

  return {
    library: {
      name: library.name,
      createdAt: library.createdAt,
      memberCount: memberships.length,
      contributionCount: contributionCounts.reduce((total, row) => total + row._count._all, 0)
    },
    members: memberships.map((membership) => ({
      id: membership.id,
      role: membership.role,
      joinedAt: membership.joinedAt,
      user: personView(membership.user),
      contributions: contributionsByUser.get(membership.userId) ?? 0,
      listening: listeningByUser.get(membership.userId) ?? null,
      activity: (activityByActor.get(membership.userId) ?? []).map((event) => activityView(event))
    }))
  };
}

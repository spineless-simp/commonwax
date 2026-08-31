import { db } from "@commonwax/db";
import { activityView } from "./activity.js";
import { describeLiveTracks } from "./catalog.js";
import { isListeningFresh, listeningCutoff } from "./overview.js";
import { avatarUrl, personSelect } from "./people.js";

/** How much of a member's own history their page shows. */
const PROFILE_ACTIVITY_LIMIT = 30;

/**
 * One member's page, for a viewer who is already inside the same Library.
 *
 * Nothing here is a play history: the only listening this reports is the same
 * transient presence row the Library overview reads, resolved through Navidrome
 * at read time and simply absent once it goes stale. Commonwax stores no record
 * of what anyone has played, and this page must not become the reason it starts.
 *
 * `email` is the one field that is not shared: it is returned only on your own
 * page, so nobody's address is readable from somebody else's.
 */
export async function buildProfile(libraryId: string, viewerId: string, userId: string) {
  const membership = await db.membership.findUnique({
    where: { userId_libraryId: { userId, libraryId } },
    include: { user: { select: { ...personSelect, email: true, createdAt: true } } }
  });
  if (!membership) return null;

  const [contributions, events, presence] = await Promise.all([
    db.contribution.count({ where: { libraryId, contributorId: userId } }),
    db.activityEvent.findMany({
      where: { libraryId, actorId: userId },
      include: { actor: { select: personSelect } },
      orderBy: { createdAt: "desc" },
      take: PROFILE_ACTIVITY_LIMIT
    }),
    db.listeningNow.findFirst({ where: { userId, libraryId, updatedAt: { gt: listeningCutoff() } } })
  ]);

  const track = presence && isListeningFresh(presence.updatedAt)
    ? (await describeLiveTracks([presence.trackReference])).get(presence.trackReference) ?? null
    : null;

  const self = viewerId === userId;
  return {
    id: membership.user.id,
    displayName: membership.user.displayName,
    avatarUrl: avatarUrl(membership.user),
    email: self ? membership.user.email : null,
    self,
    role: membership.role,
    joinedAt: membership.joinedAt,
    contributions,
    listening: track && presence ? { track, since: presence.startedAt } : null,
    activity: events.map((event) => activityView(event))
  };
}

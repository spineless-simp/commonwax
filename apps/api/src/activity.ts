import { ERASED_PERSON, avatarUrl } from "./people.js";

/**
 * Activity events are stored as a type plus a payload snapshot. Reading one back
 * is shared by the library feed and the per-member overview, so the snapshot
 * rules live here rather than in whichever route happened to need them first.
 */
export function activityView(event: any, media?: { mediaAvailable: boolean; mediaId: string | null }) {
  // Every event records the actor's name in its payload, so an event still
  // reads as that person's own after they leave the library and the relation is
  // nulled. The live user wins when they are still here (their name may have
  // changed); the payload snapshot is the fallback. Note the payload spread must
  // not come last — its `actor` is a bare name and would shadow this field.
  //
  // Erasing an account is the third case, and the reason for the last fallback:
  // `eraseAccount` in `admin.ts` clears the recorded name from the payload as
  // well as the relation, so nothing is left to name and the event reads as the
  // same "someone" their contributions do.
  const recorded = typeof event.payload?.actor === "string" ? event.payload.actor : null;
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    ...event.payload,
    actor: event.actor?.displayName ?? recorded ?? ERASED_PERSON.displayName,
    // Only a member who is still here has a profile to open. An event whose
    // actor has left keeps its recorded name and simply stops being a link.
    actorId: event.actor?.id ?? null,
    actorAvatarUrl: event.actor ? avatarUrl(event.actor) : null,
    ...media
  };
}

export function payloadId(event: any, key: string): string | null {
  const value = event?.payload?.[key];
  return typeof value === "string" ? value : null;
}

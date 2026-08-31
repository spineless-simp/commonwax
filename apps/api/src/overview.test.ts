import { describe, expect, it } from "vitest";
import { ACTIVITY_PER_MEMBER, LISTENING_WINDOW_MS, groupByActor, isListeningFresh, listeningCutoff } from "./overview.js";

const now = new Date("2026-08-27T12:00:00.000Z");

function event(id: string, actorId: string | null) {
  return { id, actorId };
}

describe("groupByActor", () => {
  it("keeps each actor's own events in feed order", () => {
    const grouped = groupByActor([event("1", "ada"), event("2", "bo"), event("3", "ada")], ACTIVITY_PER_MEMBER);
    expect(grouped.get("ada")?.map((entry) => entry.id)).toEqual(["1", "3"]);
    expect(grouped.get("bo")?.map((entry) => entry.id)).toEqual(["2"]);
  });

  it("caps each actor independently, so a busy member cannot crowd out a quiet one", () => {
    const grouped = groupByActor(
      [event("1", "ada"), event("2", "ada"), event("3", "ada"), event("4", "bo")],
      2
    );
    expect(grouped.get("ada")?.map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(grouped.get("bo")?.map((entry) => entry.id)).toEqual(["4"]);
  });

  it("drops events whose actor has left, since no member row can show them", () => {
    const grouped = groupByActor([event("1", null), event("2", "ada")], ACTIVITY_PER_MEMBER);
    expect([...grouped.keys()]).toEqual(["ada"]);
  });
});

describe("listening presence freshness", () => {
  it("treats a heartbeat inside the window as still listening", () => {
    expect(isListeningFresh(new Date(now.valueOf() - 30_000), now)).toBe(true);
  });

  it("treats a row older than the window as a listener who went away", () => {
    expect(isListeningFresh(new Date(now.valueOf() - LISTENING_WINDOW_MS - 1), now)).toBe(false);
  });

  it("excludes a row exactly at the cutoff, matching the query's strict comparison", () => {
    expect(isListeningFresh(listeningCutoff(now), now)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { formatTime } from "./player";

describe("player time display", () => {
  it("formats track duration and guards invalid values", () => {
    expect(formatTime(187)).toBe("3:07");
    expect(formatTime(Number.NaN)).toBe("0:00");
  });
});

import { describe, expect, it } from "vitest";
import { MIN_FRESH_CLOCK_SECONDS, PICK_GRACE_MS, nextAutoPickDeadline } from "@/components/draft/model";

describe("catch-up deadline math with the buzzer grace", () => {
  const s = 90;

  it("without a grace it matches the old behavior", () => {
    expect(nextAutoPickDeadline(0, 90_000, s)).toBe(90_000);
    expect(nextAutoPickDeadline(0, 89_000, s, 0)).toBe(89_000 + MIN_FRESH_CLOCK_SECONDS * 1000);
  });

  it("keeps chaining while the next deadline is older than the grace", () => {
    const now = 90_000 + PICK_GRACE_MS + 1;
    expect(nextAutoPickDeadline(0, now, s, PICK_GRACE_MS)).toBe(90_000);
  });

  it("a chained deadline still inside the grace window is not treated as overdue", () => {
    // The next team's chained deadline passed 1 s ago (inside the grace), so
    // it gets a fresh minimum clock from the real now instead of an auto-pick.
    const now = 90_000 + 1_000;
    expect(nextAutoPickDeadline(0, now, s, PICK_GRACE_MS)).toBe(now + MIN_FRESH_CLOCK_SECONDS * 1000);
  });

  it("the fresh clock runs from the real now, not now minus the grace", () => {
    const now = 89_000;
    expect(nextAutoPickDeadline(0, now, s, PICK_GRACE_MS)).toBe(now + MIN_FRESH_CLOCK_SECONDS * 1000);
  });

  it("live polling: the next team still gets a full clock chained from the expired deadline", () => {
    const expired = 500_000;
    const now = expired + PICK_GRACE_MS + 200;
    expect(nextAutoPickDeadline(expired, now, s, PICK_GRACE_MS)).toBe(expired + 90_000);
  });

  it("never moves a deadline earlier than the chained one", () => {
    for (const now of [0, 10_000, 88_500, 89_999, 90_000, 91_000, 91_500, 200_000]) {
      expect(nextAutoPickDeadline(0, now, s, PICK_GRACE_MS)).toBeGreaterThanOrEqual(90_000);
    }
  });
});

import { describe, expect, it } from "vitest";
import { budgetPhase, checkpoint, DAILY_ACTIVE_MS, DAY_MS, DRAIN_MS, LEASE_MS, usedTime } from "./budget";

describe("daily online budget", () => {
  const day = Date.UTC(2026, 10, 10);

  it("charges elapsed online time and pauses while the world is empty", () => {
    const online = checkpoint(null, day, true);
    const stopped = checkpoint(online, day + 4000, false);
    const restarted = checkpoint(stopped, day + 90_000, true);

    expect(usedTime(stopped, day + 90_000)).toBe(4000);
    expect(usedTime(restarted, day + 91_000)).toBe(5000);
  });

  it("accounts for only the committed lease when recovering after a stop", () => {
    const online = checkpoint(null, day, true);
    const recovered = checkpoint(online, day + 60_000, false);

    expect(recovered.used_ms).toBe(LEASE_MS);
    expect(recovered.active_since).toBeNull();
  });

  it("opens a drain window and stops leasing exactly at the daily limit", () => {
    const almostDrain = {
      day_start: day,
      used_ms: DAILY_ACTIVE_MS - DRAIN_MS - 100,
      active_since: null,
      lease_until: null,
    };
    const online = checkpoint(almostDrain, day, true);
    expect(budgetPhase(online, day + 99)).toBe("open");
    expect(budgetPhase(online, day + 100)).toBe("drain");

    const last = checkpoint({ ...almostDrain, used_ms: DAILY_ACTIVE_MS - 1000 }, day, true);
    expect(last.lease_until).toBe(day + 1000);
    expect(budgetPhase(last, day + 999)).toBe("drain");
    expect(budgetPhase(last, day + 1000)).toBe("closed");
    expect(checkpoint(last, day + 1000, true).lease_until).toBeNull();
  });

  it("starts a fresh budget at 09:00 KST and does not carry an old lease across", () => {
    const nextDay = day + DAY_MS;
    const prior = checkpoint(null, nextDay - 25, true);
    expect(prior.lease_until).toBe(nextDay);
    expect(usedTime(prior, nextDay - 1)).toBe(24);
    expect(checkpoint(prior, nextDay, true)).toEqual({
      day_start: nextDay,
      used_ms: 0,
      active_since: nextDay,
      lease_until: nextDay + LEASE_MS,
    });
  });
});

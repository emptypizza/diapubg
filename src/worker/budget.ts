export const MAX_PLAYERS = 8;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAILY_ACTIVE_MS = 2 * 60 * 60 * 1000;
export const DRAIN_MS = 5 * 60 * 1000;
export const LEASE_MS = 10_000;

export type BudgetCheckpoint = {
  day_start: number;
  used_ms: number;
  active_since: number | null;
  lease_until: number | null;
};

export function dayStart(now: number): number {
  // 00:00 UTC is 09:00 KST year-round.
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export function usedTime(state: BudgetCheckpoint | null, now: number): number {
  if (!state || state.day_start !== dayStart(now)) return 0;
  if (state.active_since === null || state.lease_until === null) return state.used_ms;
  const elapsed = Math.max(0, Math.min(now, state.lease_until) - state.active_since);
  return Math.min(DAILY_ACTIVE_MS, state.used_ms + elapsed);
}

export function budgetPhase(state: BudgetCheckpoint | null, now: number): "open" | "drain" | "closed" {
  const used = usedTime(state, now);
  if (used >= DAILY_ACTIVE_MS) return "closed";
  if (used >= DAILY_ACTIVE_MS - DRAIN_MS) return "drain";
  return "open";
}

export function checkpoint(state: BudgetCheckpoint | null, now: number, online: boolean): BudgetCheckpoint {
  const start = dayStart(now);
  const used = usedTime(state, now);
  // Book only time within a durable lease. A restart can account for the old
  // lease without counting a whole idle interval when no process was running.
  const lease = Math.min(LEASE_MS, DAILY_ACTIVE_MS - used, start + DAY_MS - now);
  const active = online && lease > 0;
  return {
    day_start: start,
    used_ms: used,
    active_since: active ? now : null,
    lease_until: active ? now + lease : null,
  };
}

import type { Profile, Supplies } from "../shared/protocol";
import type { BudgetCheckpoint } from "./budget";

type Guest = {
  id: string;
  tutorial_done: number;
  parts: number;
  rations: number;
  meds: number;
};

export type Reservation = {
  guest_id: string;
  expires_at: number | null;
};

export function profileFrom(guest: Guest): Profile {
  return {
    tutorialDone: guest.tutorial_done === 1,
    stash: { parts: guest.parts, rations: guest.rations, meds: guest.meds },
  };
}

export class WorldStore {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS guests (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        tutorial_done INTEGER NOT NULL DEFAULT 0,
        parts INTEGER NOT NULL DEFAULT 0,
        rations INTEGER NOT NULL DEFAULT 0,
        meds INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS guests_expiry ON guests (expires_at);
      CREATE TABLE IF NOT EXISTS reservations (
        guest_id TEXT PRIMARY KEY,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS banked_runs (
        guest_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (guest_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS daily_budget (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        day_start INTEGER NOT NULL,
        used_ms INTEGER NOT NULL,
        active_since INTEGER,
        lease_until INTEGER
      );
    `);
  }

  authenticate(hash: string, now: number): Guest | undefined {
    return this.sql.exec<Guest>(`
      SELECT id, tutorial_done, parts, rations, meds
      FROM guests WHERE token_hash = ? AND expires_at > ?
    `, hash, now).toArray()[0];
  }

  guest(id: string): Guest | undefined {
    return this.sql.exec<Guest>(`
      SELECT id, tutorial_done, parts, rations, meds FROM guests WHERE id = ?
    `, id).toArray()[0];
  }

  createGuest(id: string, hash: string, expiresAt: number): void {
    this.sql.exec("INSERT INTO guests (id, token_hash, expires_at) VALUES (?, ?, ?)", id, hash, expiresAt);
  }

  removeExpiredGuests(now: number): void {
    this.storage.transactionSync(() => {
      const expired = this.sql.exec<{ id: string }>(`
        SELECT id FROM guests
        WHERE expires_at <= ? AND id NOT IN (SELECT guest_id FROM reservations)
        ORDER BY expires_at LIMIT 32
      `, now);
      for (const { id } of expired.toArray()) {
        this.sql.exec("DELETE FROM banked_runs WHERE guest_id = ?", id);
        this.sql.exec("DELETE FROM guests WHERE id = ?", id);
      }
    });
  }

  completeTutorial(id: string): void {
    this.sql.exec("UPDATE guests SET tutorial_done = 1 WHERE id = ? AND tutorial_done = 0", id);
  }

  bank(id: string, runId: string, bag: Supplies): Supplies {
    return this.storage.transactionSync(() => {
      const receipt = this.sql.exec<{ run_id: string }>(`
        INSERT INTO banked_runs (guest_id, run_id) VALUES (?, ?)
        ON CONFLICT (guest_id, run_id) DO NOTHING RETURNING run_id
      `, id, runId).toArray()[0];
      if (receipt) {
        this.sql.exec(`
          UPDATE guests SET parts = parts + ?, rations = rations + ?, meds = meds + ?
          WHERE id = ?
        `, bag.parts, bag.rations, bag.meds, id);
      }
      const guest = this.guest(id);
      if (!guest) throw new Error("Missing guest for banked supplies");
      return profileFrom(guest).stash;
    });
  }

  reservations(): Reservation[] {
    return this.sql.exec<Reservation>("SELECT guest_id, expires_at FROM reservations").toArray();
  }

  reserve(id: string, expiresAt: number | null): void {
    this.sql.exec(`
      INSERT INTO reservations (guest_id, expires_at) VALUES (?, ?)
      ON CONFLICT (guest_id) DO UPDATE SET expires_at = excluded.expires_at
    `, id, expiresAt);
  }

  release(id: string): void {
    this.sql.exec("DELETE FROM reservations WHERE guest_id = ?", id);
  }

  budget(): BudgetCheckpoint | null {
    return this.sql.exec<BudgetCheckpoint>(`
      SELECT day_start, used_ms, active_since, lease_until FROM daily_budget WHERE id = 1
    `).toArray()[0] ?? null;
  }

  saveBudget(state: BudgetCheckpoint): void {
    this.sql.exec(`
      INSERT INTO daily_budget (id, day_start, used_ms, active_since, lease_until) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET day_start = excluded.day_start, used_ms = excluded.used_ms,
        active_since = excluded.active_since, lease_until = excluded.lease_until
    `, state.day_start, state.used_ms, state.active_since, state.lease_until);
  }
}

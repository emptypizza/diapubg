import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileFrom, WorldStore } from "./store";

describe("world SQLite persistence", () => {
  let db: DatabaseSync;
  let storage: DurableObjectStorage;
  let store: WorldStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    storage = {
      sql: {
        exec(query: string, ...values: SQLInputValue[]) {
          if (query.trimStart().startsWith("CREATE TABLE")) {
            db.exec(query);
            return;
          }
          const rows = db.prepare(query).all(...values);
          return { toArray: () => rows };
        },
      },
      transactionSync<T>(action: () => T): T {
        db.exec("BEGIN");
        try {
          const value = action();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as DurableObjectStorage;
    store = new WorldStore(storage);
  });

  afterEach(() => db.close());

  it("persists tutorial completion and banks each extraction exactly once across restarts", () => {
    store.createGuest("guest-a", "opaque-hash", 10_000);
    store.completeTutorial("guest-a");
    const bag = { parts: 2, rations: 1, meds: 0 };
    expect(store.bank("guest-a", "run-1", bag)).toEqual(bag);

    const restored = new WorldStore(storage);
    expect(restored.bank("guest-a", "run-1", bag)).toEqual(bag);
    expect(restored.bank("guest-a", "run-2", { parts: 0, rations: 0, meds: 3 })).toEqual({
      parts: 2, rations: 1, meds: 3,
    });
    const guest = restored.authenticate("opaque-hash", 100);
    expect(guest && profileFrom(guest)).toEqual({
      tutorialDone: true, stash: { parts: 2, rations: 1, meds: 3 },
    });
  });

  it("keeps a reserved guest profile through expiry and purges it after release", () => {
    store.createGuest("guest-b", "opaque-hash", 100);
    store.reserve("guest-b", 500);
    store.removeExpiredGuests(101);
    expect(store.authenticate("opaque-hash", 101)).toBeUndefined();
    expect(store.guest("guest-b")).toBeDefined();

    const restored = new WorldStore(storage);
    expect(restored.reservations()).toEqual([{ guest_id: "guest-b", expires_at: 500 }]);
    restored.release("guest-b");
    restored.removeExpiredGuests(501);
    expect(restored.guest("guest-b")).toBeUndefined();
  });
});

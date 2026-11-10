import { describe, expect, it } from 'vitest';
import { INTERACT_RADIUS, MAPS, type Point } from './maps';
import { emptySupplies, type Actor, type InputFrame, type Snapshot, type Supplies } from './protocol';
import { RECONNECT_MS, RUN_MS, World } from './world';

const availability = { open: true, canDepart: true, nextOpenAt: null };

function fixture() {
  let now = 50_000;
  const sequences = new Map<string, number>();
  const tutorialSaves: string[] = [];
  const ledger = new Map<string, Supplies>();
  const outcomes: string[] = [];
  const stash = new Map<string, Supplies>();
  let bankCalls = 0;
  let failBank = false;
  const world = new World({
    completeTutorial(id) { tutorialSaves.push(id); },
    bank(id, runId, bag) {
      bankCalls += 1;
      if (failBank) {
        failBank = false;
        throw new Error('storage temporarily unavailable');
      }
      if (!ledger.has(runId)) {
        ledger.set(runId, { ...bag });
        const old = stash.get(id) ?? emptySupplies();
        stash.set(id, { parts: old.parts + bag.parts, rations: old.rations + bag.rations, meds: old.meds + bag.meds });
      }
      return stash.get(id)!;
    },
    record(outcome) { outcomes.push(outcome); },
  });

  function join(id: string, tutorialDone = true) {
    sequences.set(id, 0);
    world.join(id, id, { tutorialDone, stash: stash.get(id) ?? emptySupplies() }, now);
  }

  function step(ms = 50) {
    now += ms;
    world.tick(now);
  }

  function snapshot(id: string): Snapshot {
    const snapshot = world.snapshot(id, availability, now);
    if (!snapshot) throw new Error(`missing snapshot: ${id}`);
    return snapshot;
  }

  function self(id: string): Actor {
    const self = snapshot(id).players.find(actor => actor.id === id);
    if (!self) throw new Error(`missing actor: ${id}`);
    return self;
  }

  function input(id: string, change: Partial<Omit<InputFrame, 'type' | 'seq'>>) {
    const seq = (sequences.get(id) ?? 0) + 1;
    sequences.set(id, seq);
    world.input(id, { type: 'input', seq, dx: 0, dy: 0, aim: 0, fire: false, interact: false, ...change });
  }

  function interact(...ids: string[]) {
    for (const id of ids) input(id, { interact: true });
    step();
  }

  function walk(ids: string[], destination: Point, within = 16) {
    const originalRoom = snapshot(ids[0]).room;
    for (let i = 0; i < 150; i++) {
      let moving = false;
      for (const id of ids) {
        if (snapshot(id).room !== originalRoom) throw new Error(`${id} unexpectedly left ${originalRoom}`);
        const actor = self(id);
        const dx = destination.x - actor.x;
        const dy = destination.y - actor.y;
        const distance = Math.hypot(dx, dy);
        if (distance > within) moving = true;
        input(id, distance > within ? { dx: dx / distance, dy: dy / distance } : {});
      }
      step();
      if (!moving) return;
    }
    throw new Error(`walk to ${destination.x}, ${destination.y} from ${JSON.stringify(ids.map(self))} stalled`);
  }

  function depart(...ids: string[]) {
    walk(ids, MAPS.hub.exit, INTERACT_RADIUS - 3);
    interact(...ids);
  }

  return {
    world, join, step, snapshot, self, input, interact, walk, depart,
    outcomes, tutorialSaves, ledger, get bankCalls() { return bankCalls; },
    get now() { return now; },
    failNextBank() { failBank = true; },
  };
}

describe('online travel', () => {
  it('isolates tutorial players and opens the exit only after moving, collecting and hitting the target', () => {
    const game = fixture();
    game.join('A', false);
    game.join('B', false);
    expect(game.snapshot('A').players.map(actor => actor.id)).toEqual(['A']);
    expect(game.snapshot('B').players.map(actor => actor.id)).toEqual(['B']);
    expect(game.snapshot('A').online).toBe(2);

    game.walk(['A'], MAPS.tutorial.exit, 40);
    game.interact('A');
    expect(game.snapshot('A').room).toBe('tutorial');
    expect(game.tutorialSaves).toEqual([]);

    game.walk(['A'], MAPS.tutorial.loot[0], 30);
    game.interact('A');
    const shooter = game.self('A');
    const target = MAPS.tutorial.target!;
    game.input('A', { aim: Math.atan2(target.y - shooter.y, target.x - shooter.x), fire: true });
    game.step();
    expect(game.snapshot('A').tutorial).toEqual({ moved: true, shot: true, picked: true });
    expect(game.snapshot('B').tutorial).toEqual({ moved: false, shot: false, picked: false });

    game.walk(['A'], MAPS.tutorial.exit, 40);
    game.interact('A');
    expect(game.snapshot('A').room).toBe('hub');
    expect(game.snapshot('B').room).toBe('tutorial');
    expect(game.tutorialSaves).toEqual(['A']);
  });

  it('reserves four field places during disconnects and releases them after the reconnect window', () => {
    const game = fixture();
    const ids = ['A', 'B', 'C', 'D', 'E'];
    ids.forEach(id => game.join(id));
    game.depart(...ids);
    expect(ids.map(id => game.snapshot(id).room)).toEqual(['field', 'field', 'field', 'field', 'hub']);
    expect(game.snapshot('E').players.map(actor => actor.id)).toEqual(['E']);

    const original = game.self('A');
    game.world.disconnect('A', game.now);
    expect(game.snapshot('B').players.find(actor => actor.id === 'A')?.connected).toBe(false);
    game.interact('E');
    expect(game.snapshot('E').room).toBe('hub');
    game.step(5_000);
    game.join('A');
    expect(game.self('A')).toMatchObject({ x: original.x, y: original.y, connected: true });
    expect(game.snapshot('A').room).toBe('field');

    game.world.disconnect('A', game.now);
    game.step(RECONNECT_MS);
    expect(game.world.has('A')).toBe(false);
    expect(game.world.reserved).toBe(4);
    expect(game.outcomes).toEqual(['lost']);
    game.interact('E');
    expect(game.snapshot('E').room).toBe('field');
    expect(game.snapshot('E').players.map(actor => actor.id)).toEqual(['B', 'C', 'D', 'E']);
  });

  it('lets only one player claim a supply and banks it once after retrying a failed save', () => {
    const game = fixture();
    game.join('A');
    game.join('B');
    game.depart('A', 'B');
    const supply = MAPS.field.loot[0];
    game.walk(['A', 'B'], supply, 38);
    game.interact('A', 'B');
    expect(game.snapshot('A').bag[supply.supply]).toBe(1);
    expect(game.snapshot('B').bag[supply.supply]).toBe(0);
    expect(game.snapshot('B').loot.find(item => item.id === supply.id)?.available).toBe(false);
    expect(game.snapshot('A').stash).toEqual(emptySupplies());

    game.walk(['A'], { x: 321, y: 575 });
    game.walk(['A'], { x: 928, y: 575 });
    game.walk(['A'], { x: 928, y: 149 }, 5);
    game.walk(['A'], MAPS.field.exit, 35);
    game.failNextBank();
    game.interact('A');
    expect(game.snapshot('A').room).toBe('field');
    expect(game.snapshot('A').bag[supply.supply]).toBe(1);
    game.interact('A');
    game.interact('A');

    expect(game.snapshot('A').room).toBe('hub');
    expect(game.snapshot('A').stash[supply.supply]).toBe(1);
    expect(game.snapshot('A').bag).toEqual(emptySupplies());
    expect(game.bankCalls).toBe(2);
    expect(game.ledger.size).toBe(1);
    expect(game.outcomes.filter(event => event === 'extracted')).toEqual(['extracted']);
  });

  it('discards run loot at the deadline and does not record the loss twice', () => {
    const game = fixture();
    game.join('A');
    game.depart('A');
    const supply = MAPS.field.loot[0];
    game.walk(['A'], supply, 38);
    game.interact('A');
    expect(game.snapshot('A').bag[supply.supply]).toBe(1);
    game.step(RUN_MS);
    game.step(RUN_MS);

    expect(game.snapshot('A').room).toBe('hub');
    expect(game.snapshot('A').stash).toEqual(emptySupplies());
    expect(game.snapshot('A').bag).toEqual(emptySupplies());
    expect(game.bankCalls).toBe(0);
    expect(game.outcomes).toEqual(['lost']);
  });
});

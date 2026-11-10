import { expect, test, type Page } from '@playwright/test';
import { MAPS, type Point } from '../src/shared/maps';
import type { InputFrame, RoomKind, Snapshot } from '../src/shared/protocol';

function observeWorld(page: Page) {
  let snapshot: Snapshot | undefined;
  let lastInput: InputFrame | undefined;
  page.on('websocket', socket => {
    if (!socket.url().endsWith('/api/world')) return;
    lastInput = undefined;
    socket.on('framesent', ({ payload }) => {
      lastInput = JSON.parse(payload.toString()) as InputFrame;
    });
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as Snapshot | { type: string };
      if (message.type === 'state') snapshot = message as Snapshot;
    });
  });
  const state = () => {
    if (!snapshot) throw new Error('Waiting for the server state');
    return snapshot;
  };
  return Object.assign(state, { lastInput: () => lastInput });
}

type ReadWorld = ReturnType<typeof observeWorld>;

async function expectRoom(page: Page, read: ReadWorld, room: RoomKind) {
  await expect(page.locator('#world')).toHaveAttribute('data-room', room);
  await expect.poll(() => read().room).toBe(room);
  await expect(page.locator('#room-name')).toHaveText(MAPS[room].name);
}

async function walk(page: Page, read: ReadWorld, destination: Point) {
  for (let step = 0; step < 12; step++) {
    const state = read();
    const player = state.players.find(actor => actor.id === state.self)!;
    const dx = destination.x - player.x;
    const dy = destination.y - player.y;
    if (Math.hypot(dx, dy) < 28) return;
    const keys: string[] = [];
    if (Math.abs(dx) > 16) keys.push(dx > 0 ? 'd' : 'a');
    if (Math.abs(dy) > 16) keys.push(dy > 0 ? 's' : 'w');
    const length = keys.length === 2 ? Math.min(Math.abs(dx), Math.abs(dy)) * Math.SQRT2 : Math.max(Math.abs(dx), Math.abs(dy));
    const startSequence = read.lastInput()?.seq ?? 0;
    for (const key of keys) await page.keyboard.down(key);
    try {
      await expect.poll(() => {
        const input = read.lastInput();
        return Boolean(input && input.seq > startSequence && (input.dx || input.dy));
      }, { intervals: [25, 50], timeout: 2500 }).toBe(true);
      // Use a bounded key hold so a delayed snapshot cannot cause a full RTT of overshoot.
      await page.waitForTimeout(Math.max(25, Math.min(1000, length * 5 - 100)));
    } finally {
      for (const key of keys) await page.keyboard.up(key);
    }
    let stopSequence: number | undefined;
    await expect.poll(() => {
      const input = read.lastInput();
      if (input && input.seq > startSequence && !input.dx && !input.dy) stopSequence ??= input.seq;
      return stopSequence !== undefined && read().ack >= stopSequence;
    }, { intervals: [25, 50, 100], timeout: 5000 }).toBe(true);
  }
  throw new Error(`Could not reach ${destination.x},${destination.y} in ${read().room}`);
}

async function interact(page: Page) {
  await expect(page.locator('#interact-button')).toBeVisible();
  await page.keyboard.press('e');
}

async function aimAt(page: Page, target: Point) {
  const canvas = page.locator('#world');
  const rect = (await canvas.boundingBox())!;
  const [zoom, offsetX, offsetY] = await canvas.evaluate((element: HTMLCanvasElement) => [
    Number(element.dataset.zoom), Number(element.dataset.offsetX), Number(element.dataset.offsetY),
  ]);
  await page.mouse.move(
    rect.x + offsetX + zoom * (target.x + 0.105 * (target.y - 320)),
    rect.y + offsetY + zoom * (0.72 * target.y - 16),
  );
}

async function finishTutorial(page: Page, read: ReadWorld) {
  await page.locator('#world').focus();
  await walk(page, read, MAPS.tutorial.loot[0]);
  await interact(page);
  await expect.poll(() => read().tutorial.picked).toBe(true);
  await aimAt(page, MAPS.tutorial.target!);
  await page.mouse.down();
  try {
    await expect.poll(() => read().tutorial.shot).toBe(true);
  } finally {
    await page.mouse.up();
  }
  for (const point of MAPS.tutorial.paths[0].slice(3, 6)) await walk(page, read, point);
  await interact(page);
  await expectRoom(page, read, 'hub');
}

async function enterField(page: Page, read: ReadWorld) {
  for (const point of MAPS.hub.paths[0].slice(3, 6)) await walk(page, read, point);
  await interact(page);
  await expectRoom(page, read, 'field');
  await expect(page.locator('#raid-clock')).toBeVisible();
}

function hasClearShot(from: Point, to: Point) {
  const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4);
  for (let step = 1; step < steps; step++) {
    const x = from.x + (to.x - from.x) * step / steps;
    const y = from.y + (to.y - from.y) * step / steps;
    if (MAPS.field.obstacles.some(wall => x >= wall.x && x <= wall.x + wall.w &&
      y >= wall.y && y <= wall.y + wall.h)) return false;
  }
  return true;
}

async function clearPatrols(page: Page, read: ReadWorld) {
  const nearby = () => {
    const state = read();
    if (state.room !== 'field') throw new Error('Guest fell during patrol combat');
    const self = state.players.find(actor => actor.id === state.self)!;
    return state.enemies
      .filter(enemy => Math.hypot(self.x - enemy.x, self.y - enemy.y) < 340 && hasClearShot(self, enemy))
      .sort((a, b) => Math.hypot(self.x - a.x, self.y - a.y) - Math.hypot(self.x - b.x, self.y - b.y))[0];
  };
  let target = nearby();
  if (!target) return;
  await aimAt(page, target);
  await page.mouse.down();
  try {
    for (let shot = 0; shot < 60 && target; shot++) {
      await aimAt(page, target);
      await page.waitForTimeout(125);
      target = nearby();
    }
  } finally {
    await page.mouse.up();
  }
  expect(target).toBeUndefined();
}

test('two guests travel from private tutorials to a shared field, reconnect, and bank loot', async ({ browser, baseURL }) => {
  const [first, second] = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  try {
    const [a, b] = await Promise.all([first.newPage(), second.newPage()]);
    const [readA, readB] = [observeWorld(a), observeWorld(b)];
    await Promise.all([a.goto('/'), b.goto('/')]);
    await Promise.all([expectRoom(a, readA, 'tutorial'), expectRoom(b, readB, 'tutorial')]);
    const [idA, idB] = [readA().self, readB().self];
    expect(idA).not.toBe(idB);
    expect(readA().players.map(player => player.id)).toEqual([idA]);
    expect(readB().players.map(player => player.id)).toEqual([idB]);

    await finishTutorial(a, readA);
    expect(readB().tutorial.picked).toBe(false);
    await finishTutorial(b, readB);
    await expect.poll(() => readA().players.map(player => player.id)).toContain(idB);
    await expect.poll(() => readB().players.map(player => player.id)).toContain(idA);
    await expect.poll(() => readA().online).toBeGreaterThanOrEqual(2);

    await enterField(a, readA);
    await enterField(b, readB);
    await expect.poll(() => readA().players.map(player => player.id)).toContain(idB);

    await walk(a, readA, MAPS.field.loot[0]);
    await clearPatrols(a, readA);
    await interact(a);
    await expect.poll(() => readA().bag.parts).toBe(1);
    const deadline = readA().deadline;
    await a.reload();
    await expectRoom(a, readA, 'field');
    expect(readA().self).toBe(idA);
    expect(readA().deadline).toBe(deadline);
    expect(readA().bag.parts).toBe(1);

    for (const point of MAPS.field.paths[0].slice(3)) {
      await walk(a, readA, point);
      await clearPatrols(a, readA);
    }
    await interact(a);
    await expectRoom(a, readA, 'hub');
    await expect(a.locator('#stash')).toHaveText('1');
    await expect.poll(() => readB().players.map(player => player.id)).not.toContain(idA);
    await a.reload();
    await expectRoom(a, readA, 'hub');
    await expect(a.locator('#stash')).toHaveText('1');
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test('a browser reconnects as the same guest after a reload', async ({ page }) => {
  const read = observeWorld(page);
  await page.goto('/');
  await expectRoom(page, read, 'tutorial');
  const guest = read().self;
  await page.reload();
  await expectRoom(page, read, 'tutorial');
  expect(read().self).toBe(guest);
  await expect(page.locator('#connection')).toHaveAttribute('data-state', 'online');
});

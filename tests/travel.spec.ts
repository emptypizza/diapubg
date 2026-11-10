import { expect, test, type Page } from '@playwright/test';
import { MAPS, type Point } from '../src/shared/maps';
import type { RoomKind, Snapshot } from '../src/shared/protocol';

function observeWorld(page: Page) {
  let snapshot: Snapshot | undefined;
  page.on('websocket', socket => {
    if (!socket.url().endsWith('/api/world')) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as Snapshot | { type: string };
      if (message.type === 'state') snapshot = message as Snapshot;
    });
  });
  return () => {
    if (!snapshot) throw new Error('Waiting for the server state');
    return snapshot;
  };
}

type ReadWorld = ReturnType<typeof observeWorld>;

async function expectRoom(page: Page, read: ReadWorld, room: RoomKind) {
  await expect(page.locator('#world')).toHaveAttribute('data-room', room);
  await expect.poll(() => read().room).toBe(room);
  await expect(page.locator('#room-name')).toHaveText(MAPS[room].name);
}

async function walk(page: Page, read: ReadWorld, destination: Point) {
  const held = new Set<string>();
  try {
    for (let step = 0; step < 65; step++) {
      const state = read();
      const player = state.players.find(actor => actor.id === state.self)!;
      const dx = destination.x - player.x;
      const dy = destination.y - player.y;
      if (Math.hypot(dx, dy) < 25) return;
      const keys = new Set<string>();
      if (Math.abs(dx) > 12) keys.add(dx > 0 ? 'd' : 'a');
      if (Math.abs(dy) > 12) keys.add(dy > 0 ? 's' : 'w');
      for (const key of held) {
        if (!keys.has(key)) {
          await page.keyboard.up(key);
          held.delete(key);
        }
      }
      for (const key of keys) {
        if (!held.has(key)) {
          await page.keyboard.down(key);
          held.add(key);
        }
      }
      await expect.poll(() => read().now, { intervals: [25, 50], timeout: 3000 }).toBeGreaterThan(state.now);
    }
    throw new Error(`Could not reach ${destination.x},${destination.y} in ${read().room}`);
  } finally {
    for (const key of held) await page.keyboard.up(key);
  }
}

async function shootAt(page: Page, target: Point) {
  const canvas = page.locator('#world');
  const rect = (await canvas.boundingBox())!;
  const [zoom, offsetX, offsetY] = await canvas.evaluate((element: HTMLCanvasElement) => [
    Number(element.dataset.zoom), Number(element.dataset.offsetX), Number(element.dataset.offsetY),
  ]);
  await page.mouse.move(
    rect.x + offsetX + zoom * (target.x + 0.105 * (target.y - 320)),
    rect.y + offsetY + zoom * (0.72 * target.y - 16),
  );
  await page.mouse.down();
}

async function finishTutorial(page: Page, read: ReadWorld) {
  await page.locator('#world').focus();
  await walk(page, read, MAPS.tutorial.loot[0]);
  await page.keyboard.press('e');
  await expect.poll(() => read().tutorial.picked).toBe(true);
  await shootAt(page, MAPS.tutorial.target!);
  try {
    await expect.poll(() => read().tutorial.shot).toBe(true);
  } finally {
    await page.mouse.up();
  }
  for (const point of MAPS.tutorial.paths[0].slice(3, 6)) await walk(page, read, point);
  await page.keyboard.press('e');
  await expectRoom(page, read, 'hub');
}

async function enterField(page: Page, read: ReadWorld) {
  for (const point of MAPS.hub.paths[0].slice(3, 6)) await walk(page, read, point);
  await page.keyboard.press('e');
  await expectRoom(page, read, 'field');
  await expect(page.locator('#raid-clock')).toBeVisible();
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
    await expect(a.locator('#population')).toContainText('2');

    await Promise.all([enterField(a, readA), enterField(b, readB)]);
    await expect.poll(() => readA().players.map(player => player.id)).toContain(idB);

    await walk(a, readA, MAPS.field.loot[0]);
    await a.keyboard.press('e');
    await expect.poll(() => readA().bag.parts).toBe(1);
    const deadline = readA().deadline;
    await a.reload();
    await expectRoom(a, readA, 'field');
    expect(readA().self).toBe(idA);
    expect(readA().deadline).toBe(deadline);
    expect(readA().bag.parts).toBe(1);

    for (const point of MAPS.field.paths[0].slice(3)) await walk(a, readA, point);
    await a.keyboard.press('e');
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

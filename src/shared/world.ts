import { HEIGHT, INTERACT_RADIUS, MAPS, WIDTH, type Obstacle, type Point } from './maps';
import { emptySupplies, type Actor, type Availability, type InputFrame, type Loot, type Profile, type RoomKind, type Shot, type Snapshot, type Supplies } from './protocol';

export const RECONNECT_MS = 30_000;
export const RUN_MS = 5 * 60_000;
const FIELD_CAPACITY = 4;
const PLAYER_RADIUS = 13;
const PLAYER_SPEED = 200;
const ENEMY_RADIUS = 14;
const ENEMY_SPEED = 74;
const ENEMY_DETECTION = 280;
const ENEMY_RANGE = 220;
const ENEMY_AIM_MS = 700;
const PLAYER_RANGE = 460;
const SHOT_COOLDOWN_MS = 240;
const INPUT_TIMEOUT_MS = 500;

type Tutorial = Snapshot['tutorial'];
type Notice = Snapshot['notice'];
type TimedShot = Shot & { expires: number };
type Enemy = Actor & { home: Point; nextFireAt: number; tracking: { id: string; since: number } | null };
type Run = { id: string; deadline: number; bag: Supplies };

type Persistence = {
  completeTutorial(id: string): void;
  bank(id: string, runId: string, bag: Supplies): Supplies;
  record(event: 'extracted' | 'lost'): void;
};

type Player = Actor & {
  room: RoomKind;
  profile: Profile;
  tutorial: Tutorial;
  distanceMoved: number;
  notice: Notice;
  run: Run | null;
  disconnectedAt: number | null;
  inputFrame: InputFrame | null;
  lastInputAt: number;
  freshInput: boolean;
  interact: boolean;
  ack: number;
  nextFireAt: number;
  tutorialShots: TimedShot[];
};

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function actorView(actor: Actor): Actor {
  const { id, name, x, y, aim, hp, connected } = actor;
  return { id, name, x, y, aim, hp, connected };
}

function shotViews(shots: TimedShot[]): Shot[] {
  return shots.map(({ id, x, y, toX, toY, enemy }) => ({ id, x, y, toX, toY, enemy }));
}

function canStand(point: Point, radius: number, obstacles: readonly Obstacle[]): boolean {
  return obstacles.every(obstacle => {
    const nearestX = clamp(point.x, obstacle.x, obstacle.x + obstacle.w);
    const nearestY = clamp(point.y, obstacle.y, obstacle.y + obstacle.h);
    return Math.hypot(point.x - nearestX, point.y - nearestY) >= radius;
  });
}

// Normalized input and separate axis collision follow the movement in emptypizza/ppi-io.
function move(point: Point, dx: number, dy: number, speed: number, dt: number, radius: number, room: RoomKind): number {
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const x = clamp(point.x + dx / Math.max(1, length) * speed * dt, radius, WIDTH - radius);
  const y = clamp(point.y + dy / Math.max(1, length) * speed * dt, radius, HEIGHT - radius);
  const start = { x: point.x, y: point.y };
  const obstacles = MAPS[room].obstacles;
  if (canStand({ x, y: point.y }, radius, obstacles)) point.x = x;
  if (canStand({ x: point.x, y }, radius, obstacles)) point.y = y;
  return distance(start, point);
}

function wallDistance(origin: Point, dx: number, dy: number, range: number, obstacle: Obstacle): number {
  let near = 0;
  let far = range;
  for (const [value, direction, min, max] of [
    [origin.x, dx, obstacle.x, obstacle.x + obstacle.w],
    [origin.y, dy, obstacle.y, obstacle.y + obstacle.h],
  ]) {
    if (Math.abs(direction) < 1e-9) {
      if (value < min || value > max) return range;
      continue;
    }
    const a = (min - value) / direction;
    const b = (max - value) / direction;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return range;
  }
  return near;
}

function targetDistance(origin: Point, target: Point, dx: number, dy: number, radius: number): number {
  const offsetX = target.x - origin.x;
  const offsetY = target.y - origin.y;
  const forward = offsetX * dx + offsetY * dy;
  const across = offsetX * dy - offsetY * dx;
  if (forward < -radius || Math.abs(across) > radius) return Infinity;
  const chord = Math.sqrt(radius * radius - across * across);
  return forward + chord < 0 ? Infinity : Math.max(0, forward - chord);
}

function trace<T extends Point>(origin: Point, aim: number, range: number, room: RoomKind, targets: readonly T[], targetRadius: number) {
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  const bounds = [
    dx > 0 ? (WIDTH - origin.x) / dx : dx < 0 ? -origin.x / dx : Infinity,
    dy > 0 ? (HEIGHT - origin.y) / dy : dy < 0 ? -origin.y / dy : Infinity,
  ];
  let length = Math.min(range, ...bounds);
  for (const obstacle of MAPS[room].obstacles) length = wallDistance(origin, dx, dy, length, obstacle);
  let hit: T | undefined;
  for (const target of targets) {
    const candidate = targetDistance(origin, target, dx, dy, targetRadius);
    if (candidate < length) {
      length = candidate;
      hit = target;
    }
  }
  return { hit, toX: origin.x + dx * length, toY: origin.y + dy * length };
}

export class World {
  private players = new Map<string, Player>();
  private enemies: Enemy[] = [];
  private fieldLoot: Loot[] = [];
  private fieldShots: TimedShot[] = [];
  private lastTick: number | null = null;
  private nextNotice = 0;
  private nextShot = 0;
  private canDepart = true;

  constructor(private readonly persistence: Persistence) {}

  get reserved(): number {
    return this.players.size;
  }

  has(id: string): boolean {
    return this.players.has(id);
  }

  setCanDepart(value: boolean): void {
    this.canDepart = value;
  }

  join(id: string, name: string, profile: Profile, now: number): void {
    this.expire(now);
    const existing = this.players.get(id);
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = null;
      existing.ack = 0;
      this.clearInput(existing);
      return;
    }
    const room = profile.tutorialDone ? 'hub' : 'tutorial';
    const { x, y } = MAPS[room].spawn;
    this.players.set(id, {
      id, name, x, y, room, aim: 0, hp: 100, connected: true,
      profile: { tutorialDone: profile.tutorialDone, stash: { ...profile.stash } },
      tutorial: { moved: profile.tutorialDone, shot: profile.tutorialDone, picked: profile.tutorialDone },
      distanceMoved: 0, notice: null, run: null, disconnectedAt: null,
      inputFrame: null, lastInputAt: now, freshInput: false, interact: false, ack: 0,
      nextFireAt: now, tutorialShots: [],
    });
  }

  disconnect(id: string, now: number): void {
    const player = this.players.get(id);
    if (!player?.connected) return;
    player.connected = false;
    player.disconnectedAt = now;
    this.clearInput(player);
  }

  input(id: string, frame: InputFrame): void {
    const player = this.players.get(id);
    if (!player?.connected || frame.seq <= player.ack) return;
    player.ack = frame.seq;
    player.inputFrame = frame;
    player.freshInput = true;
    player.interact ||= frame.interact;
  }

  tick(now: number): void {
    const dt = this.lastTick === null ? 0.05 : clamp((now - this.lastTick) / 1000, 0, 0.1);
    this.lastTick = now;
    this.expire(now);
    this.fieldShots = this.fieldShots.filter(shot => shot.expires > now);

    for (const player of this.players.values()) {
      player.tutorialShots = player.tutorialShots.filter(shot => shot.expires > now);
      if (!player.connected || !player.inputFrame) continue;
      if (player.freshInput) {
        player.lastInputAt = now;
        player.freshInput = false;
      }
      if (now - player.lastInputAt > INPUT_TIMEOUT_MS) {
        this.clearInput(player);
        continue;
      }
      const { dx, dy, aim, fire } = player.inputFrame;
      player.aim = aim;
      const traveled = move(player, dx, dy, PLAYER_SPEED, dt, PLAYER_RADIUS, player.room);
      if (player.room === 'tutorial') {
        player.distanceMoved += traveled;
        player.tutorial.moved ||= player.distanceMoved >= 35;
      }
      if (fire && now >= player.nextFireAt) this.fire(player, now);
      if (player.interact) {
        player.interact = false;
        this.interact(player, now);
      }
    }
    this.updateEnemies(now, dt);
  }

  snapshot(id: string, availability: Availability, now: number): Snapshot | null {
    const player = this.players.get(id);
    if (!player) return null;
    const others = [...this.players.values()];
    const { room, tutorial, run } = player;
    const target = MAPS.tutorial.target;
    const players = room === 'tutorial' ? [actorView(player)] : others.filter(peer => peer.room === room).map(actorView);
    let enemies: Actor[] = [];
    let loot: Loot[] = [];
    let shots: Shot[] = [];
    if (room === 'tutorial') {
      if (target && !tutorial.shot) enemies = [{ id: 'target', name: '연습 표적', ...target, aim: 0, hp: 100, connected: true }];
      loot = MAPS.tutorial.loot.map(item => ({ ...item, available: !tutorial.picked }));
      shots = shotViews(player.tutorialShots);
    }
    if (room === 'field') {
      enemies = this.enemies.filter(enemy => enemy.hp > 0).map(actorView);
      loot = this.fieldLoot.map(item => ({ ...item }));
      shots = shotViews(this.fieldShots);
    }
    return {
      type: 'state', room, self: id, players, enemies, loot, shots,
      online: others.filter(peer => peer.connected).length,
      stash: { ...player.profile.stash }, bag: run ? { ...run.bag } : emptySupplies(),
      deadline: run?.deadline ?? null, now, tutorial: { ...tutorial }, hint: this.hint(player),
      notice: player.notice, availability, ack: player.ack,
    };
  }

  private clearInput(player: Player): void {
    player.inputFrame = null;
    player.freshInput = false;
    player.interact = false;
  }

  private notify(player: Player, text: string): void {
    player.notice = { id: ++this.nextNotice, text };
  }

  private enter(player: Player, room: RoomKind, now: number): void {
    player.room = room;
    player.x = MAPS[room].spawn.x;
    player.y = MAPS[room].spawn.y;
    player.aim = 0;
    player.hp = 100;
    player.nextFireAt = now;
    this.clearInput(player);
  }

  private fieldCount(): number {
    return [...this.players.values()].filter(player => player.room === 'field').length;
  }

  private expire(now: number): void {
    for (const player of this.players.values()) {
      if (player.run && player.run.deadline <= now) this.finish(player, now, '시간이 초과됐습니다. 원정에서 얻은 보급품을 잃었습니다.');
      if (player.disconnectedAt !== null && player.disconnectedAt + RECONNECT_MS <= now) {
        if (player.run) this.finish(player, now, '연결 복구 시간이 지났습니다.');
        this.players.delete(player.id);
      }
    }
  }

  private startRun(player: Player, now: number): void {
    if (!this.canDepart) {
      this.notify(player, '지금은 원정에 출발할 수 없습니다.');
      return;
    }
    const count = this.fieldCount();
    if (count >= FIELD_CAPACITY) {
      this.notify(player, '원정 지역이 가득 찼습니다. 잠시 후 다시 시도하세요.');
      return;
    }
    if (count === 0) {
      this.fieldLoot = MAPS.field.loot.map(item => ({ ...item, available: true }));
      this.enemies = MAPS.field.enemies.map(point => ({
        ...point, name: '경비병', aim: 0, hp: 90, connected: true,
        home: { x: point.x, y: point.y }, nextFireAt: now, tracking: null,
      }));
      this.fieldShots = [];
    }
    player.run = { id: globalThis.crypto.randomUUID(), deadline: now + RUN_MS, bag: emptySupplies() };
    this.enter(player, 'field', now);
    this.notify(player, '원정 시작. 보급품을 찾고 탈출구로 이동하세요.');
  }

  private finish(player: Player, now: number, loss?: string): void {
    const run = player.run;
    if (!run) return;
    if (loss === undefined) {
      try {
        player.profile.stash = this.persistence.bank(player.id, run.id, run.bag);
      } catch {
        this.notify(player, '보급품을 저장하지 못했습니다. 탈출구에서 다시 시도하세요.');
        return;
      }
    }
    player.run = null;
    this.enter(player, 'hub', now);
    this.notify(player, loss ?? '탈출 성공. 획득한 보급품을 보관함으로 옮겼습니다.');
    this.persistence.record(loss === undefined ? 'extracted' : 'lost');
  }

  private interact(player: Player, now: number): void {
    const { room } = player;
    if (distance(player, MAPS[room].exit) <= INTERACT_RADIUS) {
      if (room === 'hub') {
        this.startRun(player, now);
      } else if (room === 'field') {
        this.finish(player, now);
      } else if (player.tutorial.moved && player.tutorial.picked && player.tutorial.shot) {
        try {
          this.persistence.completeTutorial(player.id);
        } catch {
          this.notify(player, '튜토리얼 진행 상황을 저장하지 못했습니다. 다시 시도하세요.');
          return;
        }
        player.profile.tutorialDone = true;
        this.enter(player, 'hub', now);
        this.notify(player, '튜토리얼 완료. 솔바람 쉼터에 도착했습니다.');
      } else {
        this.notify(player, '이동, 보급품 줍기, 표적 사격을 마쳐야 이동할 수 있습니다.');
      }
      return;
    }
    if (room === 'tutorial' && !player.tutorial.picked && MAPS.tutorial.loot.some(item => distance(player, item) <= INTERACT_RADIUS)) {
      player.tutorial.picked = true;
      this.notify(player, '연습 보급품을 주웠습니다.');
      return;
    }
    if (room === 'field' && player.run) {
      const item = this.fieldLoot.filter(item => item.available && distance(player, item) <= INTERACT_RADIUS)
        .sort((a, b) => distance(player, a) - distance(player, b))[0];
      if (item) {
        item.available = false;
        player.run.bag[item.supply] += 1;
        this.notify(player, '보급품을 가방에 넣었습니다.');
      }
    }
    const stash = MAPS.hub.stash;
    if (room === 'hub' && stash && distance(player, stash) <= INTERACT_RADIUS) this.notify(player, '탈출한 보급품은 보관함에 쌓입니다.');
  }

  private hint(player: Player): string {
    if (player.room === 'hub') return '출발 표지판 가까이에서 E를 눌러 원정에 출발하세요.';
    if (player.room === 'field') return 'E로 보급품을 줍고, 탈출구에서 E를 눌러 쉼터로 돌아가세요.';
    if (!player.tutorial.moved) return 'WASD 또는 방향키로 움직이세요.';
    if (!player.tutorial.picked) return '보급품 가까이에서 E를 눌러 주우세요.';
    if (!player.tutorial.shot) return '마우스로 표적을 겨냥하고 클릭해 맞히세요.';
    return '출구 가까이에서 E를 눌러 쉼터로 이동하세요.';
  }

  private fire(player: Player, now: number): void {
    if (player.room === 'hub') return;
    player.nextFireAt = now + SHOT_COOLDOWN_MS;
    if (player.room === 'tutorial') {
      const target = MAPS.tutorial.target;
      const { hit, toX, toY } = trace(player, player.aim, PLAYER_RANGE, 'tutorial', target && !player.tutorial.shot ? [target] : [], ENEMY_RADIUS);
      player.tutorialShots.push(this.shot(player, toX, toY, false, now));
      if (hit) {
        player.tutorial.shot = true;
        this.notify(player, '표적을 맞혔습니다.');
      }
      return;
    }
    const { hit, toX, toY } = trace(player, player.aim, PLAYER_RANGE, 'field', this.enemies.filter(enemy => enemy.hp > 0), ENEMY_RADIUS);
    this.fieldShots.push(this.shot(player, toX, toY, false, now));
    if (hit) hit.hp = Math.max(0, hit.hp - 30);
  }

  private shot(origin: Point, toX: number, toY: number, enemy: boolean, now: number): TimedShot {
    return { id: String(++this.nextShot), x: origin.x, y: origin.y, toX, toY, enemy, expires: now + 130 };
  }

  private updateEnemies(now: number, dt: number): void {
    const players = [...this.players.values()].filter(player => player.room === 'field');
    if (players.length === 0) return;
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0) continue;
      const target = players.filter(player => player.room === 'field').reduce<Player | undefined>((nearest, player) => {
        return !nearest || distance(enemy, player) < distance(enemy, nearest) ? player : nearest;
      }, undefined);
      if (!target) return;
      const range = distance(enemy, target);
      const destination = range <= ENEMY_DETECTION ? target : enemy.home;
      const dx = destination.x - enemy.x;
      const dy = destination.y - enemy.y;
      if (Math.hypot(dx, dy) > 6) enemy.aim = Math.atan2(dy, dx);
      const { hit, toX, toY } = trace(enemy, enemy.aim, ENEMY_RANGE, 'field', [target], PLAYER_RADIUS);
      if (!hit) enemy.tracking = null;
      else if (enemy.tracking?.id !== hit.id) enemy.tracking = { id: hit.id, since: now };
      if (enemy.tracking && now - enemy.tracking.since >= ENEMY_AIM_MS && now >= enemy.nextFireAt) {
        enemy.nextFireAt = now + 1_500;
        this.fieldShots.push(this.shot(enemy, toX, toY, true, now));
        target.hp = Math.max(0, target.hp - 14);
        if (target.hp === 0) this.finish(target, now, '원정 중 쓰러졌습니다. 원정에서 얻은 보급품을 잃었습니다.');
      }
      if ((!hit || range > ENEMY_RANGE * 0.8) && distance(enemy, destination) > 6) {
        move(enemy, dx, dy, ENEMY_SPEED, dt, ENEMY_RADIUS, 'field');
      }
    }
  }
}

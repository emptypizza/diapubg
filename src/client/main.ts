import { INTERACT_RADIUS, MAPS, type Point } from '../shared/maps';
import { SUPPLY_LABELS, type Availability, type InputFrame, type Snapshot, type Supplies, type Supply } from '../shared/protocol';
import { AIM_ELEVATION, WorldRenderer } from './renderer';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const ui = {
  canvas: byId<HTMLCanvasElement>('world'),
  connection: byId('connection'),
  connectionLabel: byId('connection-label'),
  roomName: byId('room-name'),
  roomDescription: byId('room-description'),
  zoneType: byId('zone-type'),
  zoneMarker: byId('zone-marker'),
  population: byId('population'),
  raidClock: byId('raid-clock'),
  raidTime: byId('raid-time'),
  loading: byId('loading-panel'),
  loadingTitle: byId('loading-title'),
  loadingDetail: byId('loading-detail'),
  retry: byId<HTMLButtonElement>('retry'),
  notice: byId('notice'),
  interaction: byId('interaction'),
  interactButton: byId<HTMLButtonElement>('interact-button'),
  interactionLabel: byId('interaction-label'),
  hp: byId('hp'),
  hpFill: byId('hp-fill'),
  guestName: byId('guest-name'),
  missionTitle: byId('mission-title'),
  missionDetail: byId('mission-detail'),
  fieldInstruction: byId('field-instruction'),
  tutorial: byId('tutorial-steps'),
  moved: byId('step-moved'),
  picked: byId('step-picked'),
  shot: byId('step-shot'),
  carried: byId('carried'),
  stash: byId('stash'),
  stashParts: byId('stash-parts'),
  stashRations: byId('stash-rations'),
  stashMeds: byId('stash-meds'),
  inventoryStatus: byId('inventory-status'),
  help: byId<HTMLDialogElement>('help-dialog'),
  helpToggle: byId<HTMLButtonElement>('help-toggle'),
};

const route = [...document.querySelectorAll<HTMLElement>('[data-route]')];
const touchControls = window.matchMedia('(any-pointer: coarse)').matches;
const supplyOrder: Supply[] = ['parts', 'rations', 'meds'];
const kst = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

type Connection = 'connecting' | 'online' | 'error';
type ServerError = { type: 'error'; code: string; message: string; availability?: Availability };
type Status = Availability & { online: number; reason?: string };
type Focus = Point & { label: string };

let renderer: WorldRenderer | null = null;
let state: Snapshot | null = null;
let receivedAt = 0;
let action: Focus | null = null;
let availability: Availability | undefined;
let lastNotice = 0;
let noticeTimer = 0;
let lastRoom: Snapshot['room'] | null = null;
let connection: Connection = 'connecting';
let socket: WebSocket | null = null;
let generation = 0;
let retryTimer = 0;
let connectTimeout = 0;
let retries = 0;
let seq = 0;
let previousFrame: InputFrame | null = null;
let lastSendAt = 0;
let queuedInteract = false;
let queuedShot = false;
let firing = false;
let pointer: Point | null = null;
const keyboard = new Set<string>();
const touch = new Map<number, string>();

function setText(element: HTMLElement, value: string) {
  if (element.textContent !== value) element.textContent = value;
}

function setConnection(next: Connection, title = '', detail = '') {
  connection = next;
  ui.connection.dataset.state = next;
  setText(ui.connectionLabel, next === 'online' ? '온라인' : next === 'connecting' ? '연결 중' : '연결 끊김');
  ui.loading.hidden = next === 'online';
  ui.retry.hidden = next !== 'error';
  ui.retry.disabled = next === 'connecting';
  if (next !== 'online') {
    setText(ui.loadingTitle, title);
    setText(ui.loadingDetail, detail);
    ui.interaction.hidden = true;
  }
}

function clearInput() {
  keyboard.clear();
  touch.clear();
  queuedInteract = false;
  queuedShot = false;
  firing = false;
}

function describeSupplies(supplies: Supplies) {
  return supplyOrder.map((kind) => `${SUPPLY_LABELS[kind]} ${supplies[kind]}`).join(', ');
}

function total(supplies: Supplies) {
  return supplyOrder.reduce((sum, kind) => sum + supplies[kind], 0);
}

function renderMission(snapshot: Snapshot) {
  const { room, tutorial } = snapshot;
  ui.tutorial.hidden = room !== 'tutorial';
  ui.moved.dataset.done = String(tutorial.moved);
  ui.picked.dataset.done = String(tutorial.picked);
  ui.shot.dataset.done = String(tutorial.shot);
  let title: string;
  let detail: string;
  if (room === 'field') {
    title = '물자를 챙겨 귀환';
    detail = '상자에서 물자를 줍고, 시간이 지나기 전에 탈출 신호소에 도착하세요.';
  } else if (room === 'hub') {
    title = snapshot.availability.canDepart ? '폐보급소로 출발' : '쉼터에서 대기';
    detail = snapshot.availability.canDepart ? '길 끝의 폐보급소 표지판에서 원정을 시작하세요.' : '지금은 원정에 출발할 수 없습니다.';
  } else if (!tutorial.moved) {
    title = '첫 발자국';
    detail = touchControls ? '화면 방향키로 산길을 걸어보세요.' : 'WASD 또는 방향키로 산길을 걸어보세요.';
  } else if (!tutorial.picked) {
    title = '연습 물자 줍기';
    detail = touchControls ? '길 위 상자에 다가가 줍기 버튼을 누르세요.' : '길 위 상자에 다가가 E를 눌러 보세요.';
  } else if (!tutorial.shot) {
    title = '표적 맞히기';
    detail = touchControls ? '화면에서 둥근 표적을 눌러 맞히세요.' : '둥근 표적을 향해 마우스로 조준하고 클릭하세요.';
  } else {
    title = '쉼터로 가는 길';
    detail = touchControls ? '솔바람 쉼터 표지판에 다가가 이동 버튼을 누르세요.' : '솔바람 쉼터 표지판에 다가가 E를 눌러 이동하세요.';
  }
  setText(ui.missionTitle, title);
  setText(ui.missionDetail, detail);
  setText(ui.fieldInstruction, detail);
}

function nearby(snapshot: Snapshot): Focus | null {
  const self = snapshot.players.find((actor) => actor.id === snapshot.self);
  if (!self || self.hp <= 0) return null;
  const map = MAPS[snapshot.room];
  const distance = (p: Point) => Math.hypot(p.x - self.x, p.y - self.y);
  if (distance(map.exit) <= INTERACT_RADIUS) {
    const label = snapshot.room === 'field' ? '탈출해 쉼터로 귀환' : `${map.exit.label}로 이동`;
    return { ...map.exit, label };
  }
  const loot = snapshot.loot.filter((item) => item.available && distance(item) <= INTERACT_RADIUS)
    .sort((a, b) => distance(a) - distance(b))[0];
  if (loot) return { ...loot, label: `${SUPPLY_LABELS[loot.supply]} 줍기` };
  if (map.stash && distance(map.stash) <= INTERACT_RADIUS) return { ...map.stash, label: '보관함 확인' };
  return null;
}

function updateTimer(time: number) {
  if (state?.deadline == null) return;
  const estimatedServerNow = state.now + Math.max(0, time - receivedAt);
  const seconds = Math.max(0, Math.ceil((state.deadline - estimatedServerNow) / 1000));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  setText(ui.raidTime, `${minutes}:${String(seconds % 60).padStart(2, '0')}`);
  ui.raidClock.classList.toggle('urgent', seconds <= 30);
}

function applySnapshot(snapshot: Snapshot) {
  clearTimeout(connectTimeout);
  state = snapshot;
  receivedAt = performance.now();
  availability = snapshot.availability;
  retries = 0;
  seq = Math.max(seq, snapshot.ack);
  if (connection !== 'online') setConnection('online');
  const map = MAPS[snapshot.room];
  const self = snapshot.players.find((actor) => actor.id === snapshot.self);
  ui.canvas.dataset.room = snapshot.room;
  ui.canvas.dataset.selfX = String(self?.x ?? map.spawn.x);
  ui.canvas.dataset.selfY = String(self?.y ?? map.spawn.y);
  ui.canvas.dataset.tutorialMoved = String(snapshot.tutorial.moved);
  ui.canvas.dataset.tutorialPicked = String(snapshot.tutorial.picked);
  ui.canvas.dataset.tutorialShot = String(snapshot.tutorial.shot);
  if (lastRoom !== snapshot.room) {
    lastRoom = snapshot.room;
    pointer = null;
    queuedInteract = false;
    queuedShot = false;
    firing = false;
    setText(ui.roomName, map.name);
    setText(ui.roomDescription, map.description);
    const zone = snapshot.room === 'field' ? '원정 지역' : snapshot.room === 'hub' ? '안전 지대' : '산길 전초기지';
    setText(ui.zoneType, zone);
    ui.zoneMarker.classList.toggle('danger', snapshot.room === 'field');
    ui.canvas.setAttribute('aria-label', `${map.name} 지도`);
    for (const item of route) {
      const current = item.dataset.route === snapshot.room;
      if (current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
      const marker = item.querySelector<HTMLElement>('.route-state');
      if (marker) setText(marker, current ? '현재' : '');
    }
  }
  setText(ui.population, `온라인 ${snapshot.online}명`);
  ui.raidClock.hidden = snapshot.deadline == null;
  updateTimer(receivedAt);
  const health = Math.max(0, Math.min(100, Math.round(self?.hp ?? 100)));
  setText(ui.hp, `${health} / 100`);
  ui.hpFill.style.width = `${health}%`;
  setText(ui.guestName, self?.name ?? '여행자');
  setText(ui.carried, String(total(snapshot.bag)));
  setText(ui.stash, String(total(snapshot.stash)));
  setText(ui.stashParts, String(snapshot.stash.parts));
  setText(ui.stashRations, String(snapshot.stash.rations));
  setText(ui.stashMeds, String(snapshot.stash.meds));
  ui.carried.title = describeSupplies(snapshot.bag);
  ui.stash.title = describeSupplies(snapshot.stash);
  setText(ui.inventoryStatus, snapshot.room === 'field' ? '원정 중' : '');
  action = nearby(snapshot);
  ui.interaction.hidden = !action;
  if (action) setText(ui.interactionLabel, action.label);
  renderMission(snapshot);
  if (snapshot.notice && snapshot.notice.id !== lastNotice) {
    lastNotice = snapshot.notice.id;
    setText(ui.notice, snapshot.notice.text);
    ui.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { ui.notice.hidden = true; }, 3300);
  }
}

function showFailure(code: string, message?: string) {
  clearTimeout(connectTimeout);
  clearInput();
  const titles: Record<string, string> = {
    capacity: '온라인 방이 가득 찼어요',
    budget: '오늘의 온라인 운영 종료',
    offline: '서버에 연결할 수 없어요',
    replaced: '다른 탭에서 플레이 중',
    rate_limit: '잠시 후 다시 시도해 주세요',
  };
  let detail = message || '연결 상태를 확인하고 다시 시도해 주세요.';
  if (code === 'budget' && availability?.nextOpenAt) detail = `${kst.format(availability.nextOpenAt)}에 다시 열립니다. (한국 시간)`;
  if (code === 'replaced') detail = '이 탭에서 이어 하려면 다시 연결하세요.';
  setConnection('error', titles[code] ?? '연결이 끊겼어요', detail);
}

function scheduleRetry(code: string) {
  if (code !== 'offline' && code !== 'guest' && code !== 'network') return;
  const wait = Math.min(10_000, 1000 * 2 ** retries++);
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => { void connect(); }, wait);
}

async function connect() {
  if (!renderer) return;
  const attempt = ++generation;
  clearTimeout(retryTimer);
  clearTimeout(connectTimeout);
  const previous = socket;
  socket = null;
  previous?.close();
  clearInput();
  previousFrame = null;
  lastSendAt = 0;
  seq = 0;
  lastNotice = 0;
  ui.notice.hidden = true;
  setConnection('connecting', state ? '산길에 다시 연결하는 중' : '산길을 여는 중', '온라인 방에 연결하고 있습니다.');
  try {
    const statusRequest = fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(7000) })
      .then(async (response) => response.ok ? await response.json() as Status : null)
      .catch(() => null);
    void statusRequest.then((status) => {
      if (!status || generation !== attempt || connection === 'online') return;
      availability = status;
      setText(ui.population, `온라인 ${status.online}명`);
    });
    const guest = await fetch('/api/guest', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
    if (generation !== attempt) return;
    if (!guest.ok) {
      const error = await guest.json().catch(() => null) as { reason?: string; message?: string; availability?: Availability } | null;
      if (generation !== attempt) return;
      availability = error?.availability ?? availability;
      const code = error?.reason ?? 'offline';
      showFailure(code, error?.message);
      scheduleRetry(code);
      return;
    }
    const url = new URL('/api/world', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const peer = new WebSocket(url);
    socket = peer;
    let closeReason: string | null = null;
    connectTimeout = window.setTimeout(() => {
      if (peer !== socket || connection === 'online') return;
      peer.close();
    }, 9500);
    peer.addEventListener('message', (event) => {
      if (peer !== socket || typeof event.data !== 'string') return;
      let payload: Snapshot | ServerError;
      try {
        payload = JSON.parse(event.data) as Snapshot | ServerError;
      } catch {
        return;
      }
      if (payload?.type === 'state') applySnapshot(payload);
      if (payload?.type === 'error') {
        closeReason = payload.code;
        availability = payload.availability ?? availability;
        showFailure(payload.code, payload.message);
      }
    });
    peer.addEventListener('close', (event) => {
      if (peer !== socket) return;
      socket = null;
      const code = closeReason ?? (event.code === 4001 ? 'replaced' : event.code === 4003 && event.reason ? event.reason : 'network');
      if (!closeReason) showFailure(code);
      scheduleRetry(code);
    });
  } catch {
    if (generation !== attempt) return;
    showFailure('network');
    scheduleRetry('network');
  }
}

const directionKeys: Record<string, string> = {
  KeyW: 'up', ArrowUp: 'up', KeyA: 'left', ArrowLeft: 'left',
  KeyS: 'down', ArrowDown: 'down', KeyD: 'right', ArrowRight: 'right',
};

function queueInteract() {
  if (connection === 'online' && action) queuedInteract = true;
}

function paint(time: number) {
  if (renderer) {
    updateTimer(time);
    const aimPoint = pointer ? renderer.toWorld(pointer.x, pointer.y, AIM_ELEVATION) : null;
    renderer.render(state, connection === 'online' ? action : null, time, aimPoint);
  }
  requestAnimationFrame(paint);
}

function sendInput() {
  const peer = socket;
  if (!renderer || !state || !peer || peer.readyState !== WebSocket.OPEN || connection !== 'online') return;
  const self = state.players.find((actor) => actor.id === state?.self);
  if (!self) return;
  const time = performance.now();
  if (time - lastSendAt < 100) return;
  const directions = new Set([...Array.from(keyboard, (key) => directionKeys[key]), ...touch.values()]);
  const dx = Number(directions.has('right')) - Number(directions.has('left'));
  const dy = Number(directions.has('down')) - Number(directions.has('up'));
  let aim = self.aim;
  if (pointer) {
    const aimPoint = renderer.toWorld(pointer.x, pointer.y, AIM_ELEVATION);
    aim = Math.atan2(aimPoint.y - self.y, aimPoint.x - self.x);
  }
  const fire = (firing || queuedShot) && state.room !== 'hub';
  const interact = queuedInteract;
  if (previousFrame && !dx && !dy && !fire && !interact &&
    previousFrame.dx === dx && previousFrame.dy === dy && !previousFrame.fire && !previousFrame.interact &&
    Math.abs(previousFrame.aim - aim) < .02) return;
  const frame: InputFrame = { type: 'input', seq: ++seq, dx, dy, aim, fire, interact };
  try {
    peer.send(JSON.stringify(frame));
  } catch {
    peer.close();
    return;
  }
  previousFrame = frame;
  lastSendAt = time;
  queuedInteract = false;
  queuedShot = false;
}

ui.interactButton.addEventListener('click', () => {
  queueInteract();
  ui.canvas.focus({ preventScroll: true });
});
ui.retry.addEventListener('click', () => {
  retries = 0;
  void connect();
});
ui.helpToggle.addEventListener('click', () => {
  clearInput();
  ui.help.showModal();
});
ui.help.addEventListener('close', () => ui.canvas.focus({ preventScroll: true }));
window.addEventListener('keydown', (event) => {
  if (ui.help.open || event.altKey || event.metaKey || event.ctrlKey) return;
  const direction = directionKeys[event.code];
  if (direction) {
    event.preventDefault();
    keyboard.add(event.code);
  } else if (event.code === 'KeyE' && !event.repeat) {
    event.preventDefault();
    queueInteract();
  }
});
window.addEventListener('keyup', (event) => keyboard.delete(event.code));
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInput();
});
window.addEventListener('pagehide', () => {
  generation++;
  clearTimeout(retryTimer);
  clearTimeout(connectTimeout);
  const peer = socket;
  socket = null;
  peer?.close();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void connect();
});
ui.canvas.addEventListener('pointermove', (event) => {
  pointer = { x: event.clientX, y: event.clientY };
});
ui.canvas.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0 || connection !== 'online') return;
  event.preventDefault();
  ui.canvas.focus({ preventScroll: true });
  pointer = { x: event.clientX, y: event.clientY };
  queuedShot = true;
  firing = true;
});
window.addEventListener('pointerup', (event) => {
  if (event.isPrimary && event.button === 0) firing = false;
});
window.addEventListener('pointercancel', (event) => {
  if (!event.isPrimary) return;
  firing = false;
  queuedShot = false;
});
ui.canvas.addEventListener('pointerleave', () => {
  firing = false;
  if (!queuedShot) pointer = null;
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-move]')) {
  button.addEventListener('pointerdown', (event) => {
    if (!button.dataset.move) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touch.set(event.pointerId, button.dataset.move);
  });
  for (const kind of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(kind, (event) => touch.delete((event as PointerEvent).pointerId));
  }
}

try {
  renderer = new WorldRenderer(ui.canvas);
  requestAnimationFrame(paint);
  window.setInterval(sendInput, 34);
  void connect();
} catch {
  setConnection('error', '게임 화면을 열 수 없어요', 'Canvas 2D를 지원하는 브라우저에서 페이지를 다시 열어 주세요.');
  ui.retry.hidden = true;
}

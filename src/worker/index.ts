import { DurableObject } from "cloudflare:workers";
import { decodeInput, type Availability } from "../shared/protocol";
import { RECONNECT_MS, World } from "../shared/world";
import {
  budgetPhase, checkpoint, DAY_MS, dayStart, LEASE_MS, MAX_PLAYERS,
  type BudgetCheckpoint,
} from "./budget";
import { profileFrom, WorldStore } from "./store";

interface Env {
  ASSETS: Fetcher;
  WORLD: DurableObjectNamespace<GameWorld>;
  ONLINE_ENABLED?: string;
}

type Status = Availability & { online: number; reason?: "capacity" | "budget" | "offline" };

type Connection = {
  socket: WebSocket;
  window: number;
  messages: number;
};

const COOKIE_AGE = 30 * DAY_MS;
const TICK_MS = 50;
const SNAPSHOT_MS = 100;
const MAX_FRAME_LENGTH = 512;
const FRAMES_PER_SECOND = 25;
const GUESTS_PER_MINUTE = 24;

function apiJson(value: unknown, status = 200, headers?: HeadersInit): Response {
  const all = new Headers(headers);
  all.set("Cache-Control", "no-store");
  all.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { status, headers: all });
}

function apiError(status: number, reason: string, message: string): Response {
  return apiJson({ reason, message }, status);
}

function metric(event: string, properties: Record<string, number | string> = {}): void {
  console.info({ component: "world", event, ...properties });
}

function errorFrame(code: string, message: string, availability?: Availability): string {
  return JSON.stringify({ type: "error", code, message, availability });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try { socket.close(code, reason); } catch { /* already closed by peer */ }
}

function cookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-diapubg_guest" : "diapubg_guest";
}

function readToken(request: Request): string | undefined {
  const name = cookieName(new URL(request.url)) + "=";
  const cookie = request.headers.get("Cookie");
  const value = cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(name))?.slice(name.length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

function guestName(id: string): string {
  return `손님-${id.slice(0, 6)}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const method = { "/api/status": "GET", "/api/guest": "POST", "/api/world": "GET" }[url.pathname];
    if (!method) return apiError(404, "not_found", "알 수 없는 요청입니다.");
    if (request.method !== method) {
      return apiJson({ reason: "method", message: "지원하지 않는 요청입니다." }, 405, { Allow: method });
    }
    if (url.pathname !== "/api/status") {
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (request.headers.get("Origin") !== url.origin || (url.protocol !== "https:" && !local)) {
        return apiError(403, "origin", "같은 사이트에서 접속해 주세요.");
      }
    }
    if (url.pathname === "/api/world" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return apiError(426, "upgrade", "WebSocket 연결이 필요합니다.");
    }

    try {
      return await env.WORLD.getByName("online-alpha").fetch(request);
    } catch {
      console.error({ component: "worker", event: "world_unavailable", path: url.pathname });
      return apiError(503, "offline", "온라인 서버에 잠시 연결할 수 없습니다.");
    }
  },
} satisfies ExportedHandler<Env>;

export class GameWorld extends DurableObject<Env> {
  private readonly store: WorldStore;
  private readonly world: World;
  private readonly connections = new Map<string, Connection>();
  private readonly socketIds = new WeakMap<WebSocket, string>();
  private readonly grace = new Map<string, number>();
  private readonly guestCounts = new Map<string, number>();
  private guestWindow = -1;
  private budget: BudgetCheckpoint | null;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private nextSnapshot = 0;
  private failed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WorldStore(ctx.storage);
    this.budget = this.store.budget();
    this.world = new World({
      completeTutorial: id => this.store.completeTutorial(id),
      bank: (id, runId, bag) => this.store.bank(id, runId, bag),
      record: event => metric(event),
    });
    this.restoreConnections(Date.now());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/status":
        this.refresh(Date.now());
        return apiJson(this.status(Date.now()));
      case "/api/guest":
        return this.guest(request, url);
      case "/api/world":
        return this.upgradeWorld(request);
      default:
        return apiError(404, "not_found", "알 수 없는 요청입니다.");
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const id = this.socketIds.get(socket);
    const connection = id && this.connections.get(id);
    if (!id || !connection || connection.socket !== socket) return;
    const now = Date.now();
    const second = Math.floor(now / 1000);
    if (connection.window !== second) {
      connection.window = second;
      connection.messages = 0;
    }
    if (++connection.messages > FRAMES_PER_SECOND) {
      this.endConnection(socket, 1008, "rate_limit", "입력 요청이 너무 많습니다.", now);
      return;
    }
    if (typeof message !== "string" || message.length > MAX_FRAME_LENGTH) {
      this.endConnection(socket, 1009, "invalid_input", "입력 메시지가 너무 큽니다.", now);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(message); } catch { /* validated below */ }
    const input = decodeInput(parsed);
    if (!input) {
      this.endConnection(socket, 1008, "invalid_input", "입력 형식이 올바르지 않습니다.", now);
      return;
    }
    this.world.input(id, input);
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.detach(socket, Date.now());
    try {
      if (code === 1005 || code === 1006 || code === 1015) socket.close();
      else socket.close(code, reason);
    } catch { /* the runtime already replied to the close */ }
  }

  webSocketError(socket: WebSocket): void {
    this.detach(socket, Date.now());
    closeSocket(socket, 1011, "offline");
  }

  private async guest(request: Request, url: URL): Promise<Response> {
    const token = readToken(request);
    if (token && this.store.authenticate(await hashToken(token), Date.now())) return apiJson({ ok: true });
    if (this.isOffline()) return apiError(503, "offline", "온라인 서버가 준비 중입니다.");

    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    if (minute !== this.guestWindow) {
      this.guestWindow = minute;
      this.guestCounts.clear();
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    const count = this.guestCounts.get(ip) ?? 0;
    if (count >= GUESTS_PER_MINUTE || (count === 0 && this.guestCounts.size >= 2048)) {
      return apiJson({ reason: "rate_limit", message: "잠시 후 다시 시도해 주세요." }, 429, { "Retry-After": "60" });
    }
    this.guestCounts.set(ip, count + 1);

    const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await hashToken(secret);
    this.store.removeExpiredGuests(now);
    this.store.createGuest(crypto.randomUUID(), hash, now + COOKIE_AGE);
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return apiJson({ ok: true }, 200, {
      "Set-Cookie": `${cookieName(url)}=${secret}; Path=/; Max-Age=${COOKIE_AGE / 1000}; HttpOnly; SameSite=Strict${secure}`,
    });
  }

  private async upgradeWorld(request: Request): Promise<Response> {
    const token = readToken(request);
    const hash = token && await hashToken(token);
    const now = Date.now();
    const guest = hash ? this.store.authenticate(hash, now) : undefined;
    if (!guest) return this.rejectUpgrade("guest", "게스트 세션을 다시 시작해 주세요.");

    this.refresh(now);
    const status = this.status(now);
    const existing = this.world.has(guest.id);
    if (status.reason === "offline") {
      return this.rejectUpgrade("offline", "온라인 서버가 준비 중입니다.", status);
    }
    const phase = budgetPhase(this.budget, now);
    if (phase === "closed" || (phase === "drain" && !existing)) {
      return this.rejectUpgrade("budget", "오늘의 온라인 이용 시간이 끝나갑니다.", status);
    }
    if (!existing && this.world.reserved >= MAX_PLAYERS) {
      return this.rejectUpgrade("capacity", "현재 월드가 가득 찼습니다.", status);
    }

    const [client, server] = Object.values(new WebSocketPair());
    const previous = this.connections.get(guest.id);
    const startBudget = this.connections.size === 0;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(guest.id);
    this.socketIds.set(server, guest.id);
    this.connections.set(guest.id, { socket: server, window: -1, messages: 0 });
    this.grace.delete(guest.id);
    this.store.reserve(guest.id, null);
    this.world.join(guest.id, guestName(guest.id), profileFrom(guest), now);
    if (startBudget) this.saveBudget(now);

    if (previous) {
      previous.socket.serializeAttachment(null);
      this.notifyError(previous.socket, 4001, "replaced", "다른 탭에서 접속했습니다.");
    }
    this.schedule();
    this.sendSnapshot(guest.id, server, this.status(now), now);
    metric(existing ? "reconnected" : "joined", { online: this.connections.size });
    return new Response(null, { status: 101, webSocket: client });
  }

  private rejectUpgrade(code: string, message: string, availability?: Availability): Response {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.notifyError(server, 4003, code, message, availability);
    metric("rejected", { reason: code });
    return new Response(null, { status: 101, webSocket: client });
  }

  private notifyError(socket: WebSocket, closeCode: number, code: string, message: string, availability?: Availability): void {
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.send(errorFrame(code, message, availability)); } catch { /* already closed by peer */ }
    }
    closeSocket(socket, closeCode, code);
  }

  private endConnection(socket: WebSocket, closeCode: number, code: string, message: string, now: number): void {
    this.detach(socket, now);
    this.notifyError(socket, closeCode, code, message, this.status(now));
  }

  private detach(socket: WebSocket, now: number): void {
    const id = this.socketIds.get(socket);
    if (!id || this.connections.get(id)?.socket !== socket) return;
    this.connections.delete(id);
    this.world.disconnect(id, now);
    const until = now + RECONNECT_MS;
    this.grace.set(id, until);
    this.store.reserve(id, until);
    if (!this.connections.size) this.saveBudget(now);
    this.schedule();
    metric("disconnected", { online: this.connections.size });
  }

  private restoreConnections(now: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const id: unknown = socket.deserializeAttachment();
      const guest = typeof id === "string" ? this.store.guest(id) : undefined;
      if (!guest || this.connections.has(guest.id) || this.connections.size >= MAX_PLAYERS) {
        closeSocket(socket, 1011, "offline");
        continue;
      }
      this.world.join(guest.id, guestName(guest.id), profileFrom(guest), now);
      this.socketIds.set(socket, guest.id);
      this.connections.set(guest.id, { socket, window: -1, messages: 0 });
    }
    for (const { guest_id: id, expires_at: expiry } of this.store.reservations()) {
      if (this.connections.has(id)) continue;
      const guest = this.store.guest(id);
      const until = expiry ?? now + RECONNECT_MS;
      if (until <= now || !guest || this.world.reserved >= MAX_PLAYERS) {
        this.store.release(id);
        continue;
      }
      this.world.join(id, guestName(id), profileFrom(guest), now);
      this.world.disconnect(id, until - RECONNECT_MS);
      this.grace.set(id, until);
      if (expiry === null) this.store.reserve(id, until);
    }
    if (this.budget?.active_since != null || this.connections.size) this.saveBudget(now);
    this.refresh(now);
    this.schedule();
  }

  private isOffline(): boolean {
    return this.failed || this.env.ONLINE_ENABLED === "false";
  }

  private status(now: number): Status {
    const online = this.connections.size;
    if (this.isOffline()) return { open: false, canDepart: false, nextOpenAt: null, online, reason: "offline" };
    if (budgetPhase(this.budget, now) !== "open") {
      return { open: false, canDepart: false, nextOpenAt: dayStart(now) + DAY_MS, online, reason: "budget" };
    }
    if (this.world.reserved >= MAX_PLAYERS) {
      return { open: false, canDepart: true, nextOpenAt: null, online, reason: "capacity" };
    }
    return { open: true, canDepart: true, nextOpenAt: null, online };
  }

  private saveBudget(now: number): void {
    this.budget = checkpoint(this.budget, now, this.connections.size > 0 && !this.isOffline());
    this.store.saveBudget(this.budget);
  }

  private refresh(now: number): void {
    const phase = budgetPhase(this.budget, now);
    const offline = this.isOffline();
    this.world.setCanDepart(phase === "open" && !offline);
    if (this.connections.size && (phase === "closed" || offline)) {
      const code = offline ? "offline" : "budget";
      metric("world_closed", { reason: code });
      for (const { socket } of this.connections.values()) {
        this.endConnection(socket, 4003, code, "온라인 서버가 종료됐습니다.", now);
      }
    }
    if (this.connections.size) {
      const state = this.budget;
      if (state?.lease_until == null || state.active_since === null || state.day_start !== dayStart(now) ||
        now >= state.lease_until ||
        (state.lease_until - state.active_since === LEASE_MS && now + TICK_MS * 2 >= state.lease_until)) {
        this.saveBudget(now);
      }
    }
    const expired = [...this.grace.entries()].filter(([, until]) => until <= now);
    if (expired.length) {
      this.world.tick(now);
      for (const [id] of expired) {
        this.grace.delete(id);
        this.store.release(id);
      }
    }
  }

  private schedule(): void {
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    if (this.connections.size && !this.failed) {
      this.tickTimer ??= setInterval(() => this.runTick(), TICK_MS);
      return;
    }
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    if (this.grace.size && !this.failed) {
      // Keep the in-memory run available during reconnect grace with a single timer.
      const next = Math.min(...this.grace.values());
      this.graceTimer = setTimeout(() => this.runTick(), Math.max(1, next - Date.now()));
    }
  }

  private runTick(): void {
    try {
      const now = Date.now();
      this.refresh(now);
      if (!this.connections.size) {
        this.schedule();
        return;
      }
      this.world.tick(now);
      if (now < this.nextSnapshot) return;
      this.nextSnapshot = now + SNAPSHOT_MS;
      const status = this.status(now);
      for (const [id, { socket }] of this.connections) this.sendSnapshot(id, socket, status, now);
    } catch {
      this.failed = true;
      console.error({ component: "world", event: "simulation_failed" });
      for (const { socket } of this.connections.values()) {
        this.notifyError(socket, 1011, "offline", "온라인 서버를 잠시 사용할 수 없습니다.");
      }
      this.connections.clear();
      this.schedule();
    }
  }

  private sendSnapshot(id: string, socket: WebSocket, status: Status, now: number): void {
    const snapshot = this.world.snapshot(id, status, now);
    try {
      if (snapshot && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(snapshot));
        return;
      }
    } catch { /* socket was lost while sending */ }
    this.detach(socket, now);
    closeSocket(socket, 1011, "offline");
  }
}

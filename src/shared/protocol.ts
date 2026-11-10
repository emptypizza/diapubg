export type RoomKind = 'tutorial' | 'hub' | 'field';
export type Supply = 'parts' | 'rations' | 'meds';
export type Supplies = Record<Supply, number>;

export const SUPPLY_LABELS: Record<Supply, string> = {
  parts: '부품',
  rations: '식량',
  meds: '의약품',
};

export function emptySupplies(): Supplies {
  return { parts: 0, rations: 0, meds: 0 };
}

export interface Profile {
  tutorialDone: boolean;
  stash: Supplies;
}

export interface InputFrame {
  type: 'input';
  seq: number;
  dx: number;
  dy: number;
  aim: number;
  fire: boolean;
  interact: boolean;
}

export interface Actor {
  id: string;
  name: string;
  x: number;
  y: number;
  aim: number;
  hp: number;
  connected: boolean;
}

export interface Loot {
  id: string;
  x: number;
  y: number;
  available: boolean;
  supply: Supply;
}

export interface Shot {
  id: string;
  x: number;
  y: number;
  toX: number;
  toY: number;
  enemy: boolean;
}

export interface Availability {
  open: boolean;
  canDepart: boolean;
  nextOpenAt: number | null;
}

export interface Snapshot {
  type: 'state';
  room: RoomKind;
  self: string;
  players: Actor[];
  enemies: Actor[];
  loot: Loot[];
  shots: Shot[];
  online: number;
  stash: Supplies;
  bag: Supplies;
  deadline: number | null;
  now: number;
  tutorial: { moved: boolean; shot: boolean; picked: boolean };
  hint: string;
  notice: { id: number; text: string } | null;
  availability: Availability;
  ack: number;
}

export function decodeInput(raw: unknown): InputFrame | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { type, seq, dx, dy, aim, fire, interact } = raw as Record<string, unknown>;
  if (
    type !== 'input' ||
    typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 ||
    typeof dx !== 'number' || !Number.isFinite(dx) || Math.abs(dx) > 1 ||
    typeof dy !== 'number' || !Number.isFinite(dy) || Math.abs(dy) > 1 ||
    typeof aim !== 'number' || !Number.isFinite(aim) || Math.abs(aim) > Math.PI ||
    typeof fire !== 'boolean' || typeof interact !== 'boolean'
  ) return null;
  return { type, seq, dx, dy, aim, fire, interact };
}

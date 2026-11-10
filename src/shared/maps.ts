import type { RoomKind, Supply } from './protocol';

export const WIDTH = 960;
export const HEIGHT = 640;
export const INTERACT_RADIUS = 53;

export interface Point {
  x: number;
  y: number;
}

export interface Obstacle extends Point {
  w: number;
  h: number;
  kind: 'rock' | 'tree' | 'wall' | 'crate';
}

export interface MapSpec {
  name: string;
  description: string;
  spawn: Point;
  exit: Point & { label: string };
  obstacles: Obstacle[];
  loot: Array<Point & { id: string; supply: Supply }>;
  target?: Point;
  stash?: Point;
  enemies: Array<Point & { id: string }>;
  paths: Point[][];
}

export const MAPS: Record<RoomKind, MapSpec> = {
  tutorial: {
    name: '산길 훈련소',
    description: '안개가 걷히는 산길에서 움직임과 사격을 익힙니다.',
    spawn: { x: 174, y: 464 },
    exit: { x: 758, y: 211, label: '솔바람 쉼터' },
    loot: [{ id: 'training-kit', x: 345, y: 420, supply: 'parts' }],
    target: { x: 524, y: 324 },
    enemies: [],
    paths: [
      [{ x: 79, y: 519 }, { x: 175, y: 464 }, { x: 345, y: 420 }, { x: 526, y: 371 }, { x: 656, y: 288 }, { x: 758, y: 211 }, { x: 850, y: 152 }],
    ],
    obstacles: [
      { x: 100, y: 227, w: 46, h: 51, kind: 'tree' },
      { x: 184, y: 289, w: 39, h: 48, kind: 'tree' },
      { x: 298, y: 257, w: 67, h: 33, kind: 'rock' },
      { x: 271, y: 491, w: 42, h: 40, kind: 'tree' },
      { x: 455, y: 467, w: 65, h: 38, kind: 'rock' },
      { x: 625, y: 156, w: 46, h: 45, kind: 'tree' },
      { x: 679, y: 426, w: 40, h: 48, kind: 'tree' },
      { x: 779, y: 350, w: 68, h: 36, kind: 'rock' },
      { x: 851, y: 235, w: 47, h: 49, kind: 'tree' },
    ],
  },
  hub: {
    name: '솔바람 쉼터',
    description: '동료 여행자들과 쉬고, 폐보급소로 향할 채비를 합니다.',
    spawn: { x: 167, y: 453 },
    exit: { x: 767, y: 221, label: '폐보급소' },
    stash: { x: 373, y: 374 },
    loot: [],
    enemies: [],
    paths: [
      [{ x: 65, y: 517 }, { x: 167, y: 453 }, { x: 373, y: 402 }, { x: 500, y: 375 }, { x: 634, y: 316 }, { x: 767, y: 221 }, { x: 864, y: 156 }],
      [{ x: 500, y: 375 }, { x: 571, y: 456 }, { x: 668, y: 510 }],
    ],
    obstacles: [
      { x: 114, y: 279, w: 52, h: 53, kind: 'tree' },
      { x: 222, y: 247, w: 69, h: 38, kind: 'rock' },
      { x: 335, y: 233, w: 188, h: 91, kind: 'wall' },
      { x: 274, y: 509, w: 50, h: 48, kind: 'tree' },
      { x: 577, y: 209, w: 45, h: 43, kind: 'tree' },
      { x: 685, y: 393, w: 71, h: 39, kind: 'rock' },
      { x: 779, y: 486, w: 48, h: 53, kind: 'tree' },
      { x: 836, y: 291, w: 56, h: 48, kind: 'tree' },
    ],
  },
  field: {
    name: '폐보급소',
    description: '순찰대를 피해 물자를 챙겨 탈출 신호소로 이동합니다.',
    spawn: { x: 144, y: 495 },
    exit: { x: 804, y: 150, label: '탈출 신호소' },
    loot: [
      { id: 'supply-west', x: 319, y: 467, supply: 'parts' },
      { id: 'supply-center', x: 533, y: 356, supply: 'rations' },
      { id: 'supply-east', x: 689, y: 300, supply: 'meds' },
      { id: 'supply-north', x: 637, y: 184, supply: 'parts' },
    ],
    enemies: [
      { id: 'patrol-west', x: 429, y: 365 },
      { id: 'patrol-east', x: 733, y: 360 },
      { id: 'patrol-north', x: 686, y: 204 },
    ],
    paths: [
      [{ x: 70, y: 548 }, { x: 144, y: 495 }, { x: 319, y: 467 }, { x: 523, y: 406 }, { x: 646, y: 323 }, { x: 747, y: 230 }, { x: 804, y: 150 }],
      [{ x: 523, y: 406 }, { x: 537, y: 291 }, { x: 637, y: 184 }, { x: 804, y: 150 }],
    ],
    obstacles: [
      { x: 134, y: 276, w: 58, h: 44, kind: 'rock' },
      { x: 234, y: 342, w: 100, h: 58, kind: 'wall' },
      { x: 342, y: 211, w: 127, h: 78, kind: 'wall' },
      { x: 403, y: 470, w: 62, h: 43, kind: 'crate' },
      { x: 548, y: 224, w: 59, h: 45, kind: 'crate' },
      { x: 628, y: 447, w: 121, h: 63, kind: 'wall' },
      { x: 792, y: 323, w: 48, h: 49, kind: 'tree' },
      { x: 859, y: 204, w: 46, h: 40, kind: 'rock' },
    ],
  },
};

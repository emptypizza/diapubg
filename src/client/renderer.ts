import { HEIGHT, MAPS, WIDTH, type MapSpec } from '../shared/maps';
import type { Actor, RoomKind, Snapshot, Supply } from '../shared/protocol';

type Point = { x: number; y: number };
type Paint = (ctx: CanvasRenderingContext2D) => void;
type Prop = { depth: number; paint: Paint };

const TILT = 0.72;
const SHEAR = 0.105;
export const AIM_ELEVATION = 16;
const GROUND = { x: -390, y: -400, width: 1780, height: 1260 };
const supplyColors: Record<Supply, string> = { parts: '#dda572', rations: '#b6c982', meds: '#db9c93' };

const worldX = (x: number, y: number) => x + (y - HEIGHT / 2) * SHEAR;
const worldY = (y: number) => y * TILT;
const project = (point: Point) => ({ x: worldX(point.x, point.y), y: worldY(point.y) });

function seeded(seed: number) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient, rotation = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function polygon(ctx: CanvasRenderingContext2D, points: Point[], fill: string | CanvasGradient, stroke?: string) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function line(ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string, width = 1) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
  light.addColorStop(0, color);
  light.addColorStop(1, 'transparent');
  ellipse(ctx, x, y, radius, radius, light);
}

function grass(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(x - size * .2, y);
  ctx.quadraticCurveTo(x - size * .4, y - size * .6, x - size, y - size);
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + size * .3, y - size * .65, x + size * .22, y - size * 1.25);
  ctx.moveTo(x + size * .2, y);
  ctx.quadraticCurveTo(x + size * .45, y - size * .6, x + size * .8, y - size * .7);
  ctx.strokeStyle = color;
  ctx.lineWidth = .8;
  ctx.stroke();
}

function nearSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function inPath(point: Point, paths: Point[][], distance: number) {
  return paths.some((path) => path.some((p, i) => i > 0 && nearSegment(point, path[i - 1], p) < distance));
}

function tracePath(ctx: CanvasRenderingContext2D, points: Point[], color: string | CanvasGradient, width: number) {
  if (!points.length) return;
  const rendered = points.map(project);
  ctx.beginPath();
  ctx.moveTo(rendered[0].x, rendered[0].y);
  for (let i = 1; i < rendered.length - 1; i++) {
    const p = rendered[i];
    const next = rendered[i + 1];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  const last = rendered[rendered.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawPine(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, sway: number, colorIndex = 0) {
  const greens = [
    ['#3b4b3e', '#556749', '#6b7951', '#455b43'],
    ['#3f5148', '#577065', '#758574', '#4f6658'],
    ['#48523f', '#687253', '#828965', '#59654c'],
    ['#353f37', '#4f5b49', '#697258', '#465342'],
  ][colorIndex % 4];
  const width = height * .48;
  ellipse(ctx, x + width * .4, y + 5, width * .69, width * .23, '#26332756', -.11);
  const root = Math.max(2, height * .034);
  polygon(ctx, [
    { x: x - root, y }, { x: x + root, y: y - 1 }, { x: x + sway * .54 + root / 3, y: y - height * .74 }, { x: x + sway * .54 - root / 3, y: y - height * .74 },
  ], '#605544');
  line(ctx, { x: x - root * .52, y: y - 3 }, { x: x + sway * .42, y: y - height * .36 }, '#917c55', Math.max(.7, root * .35));
  for (let i = 0; i < 5; i++) {
    const base = y - height * (.19 + i * .135);
    const top = base - height * (.30 + i * .018);
    const center = x + sway * i / 4;
    const span = width * (.64 - i * .098);
    const layers = ctx.createLinearGradient(center - span, top, center + span, base);
    layers.addColorStop(0, greens[2]);
    layers.addColorStop(.48, greens[1]);
    layers.addColorStop(1, greens[0]);
    polygon(ctx, [
      { x: center + sway * .15, y: top }, { x: center - span * .38, y: base - height * .11 }, { x: center - span * .64, y: base - height * .058 },
      { x: center - span, y: base - 2 }, { x: center - span * .67, y: base + height * .026 }, { x: center - span * .27, y: base + height * .012 },
      { x: center + span * .02, y: base + height * .047 }, { x: center + span * .47, y: base + height * .023 }, { x: center + span * .92, y: base - 1 },
      { x: center + span * .61, y: base - height * .048 }, { x: center + span * .37, y: base - height * .12 },
    ], layers);
    line(ctx, { x: center - span * .7, y: base - 1 }, { x: center - span * .34, y: base + height * .009 }, '#a3a4744b', .8);
    line(ctx, { x: center + span * .15, y: base + height * .023 }, { x: center + span * .68, y: base - 1 }, greens[3], 1.15);
  }
}

const pineSprites = new Map<string, HTMLCanvasElement>();

function pine(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, sway: number, colorIndex = 0) {
  const slant = Math.round(sway / 4) * 4;
  const key = `${colorIndex}:${slant}`;
  let sprite = pineSprites.get(key);
  if (!sprite) {
    sprite = document.createElement('canvas');
    sprite.width = 128;
    sprite.height = 132;
    const paint = sprite.getContext('2d');
    if (!paint) return;
    drawPine(paint, 64, 113, 100, slant, colorIndex);
    pineSprites.set(key, sprite);
  }
  const scale = height / 100;
  ctx.drawImage(sprite, x - 64 * scale, y - 113 * scale, sprite.width * scale, sprite.height * scale);
}

function stone(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, lichen = false) {
  ellipse(ctx, x + width * .16, y + 1.5, width * .66, height * .29, '#29322756');
  const top = [
    { x: x - width * .59, y: y - height * .34 }, { x: x - width * .39, y: y - height * .91 },
    { x: x + width * .06, y: y - height }, { x: x + width * .47, y: y - height * .65 },
    { x: x + width * .56, y: y - height * .29 }, { x: x + width * .11, y: y - height * .37 },
  ];
  polygon(ctx, top, '#a49e87');
  polygon(ctx, [
    top[0], top[5], top[4], { x: x + width * .34, y }, { x: x - width * .32, y: y + height * .04 },
  ], '#696d5c');
  polygon(ctx, [top[1], top[2], top[3], { x: x + width * .14, y: y - height * .56 }], '#c0b49a57');
  if (lichen) ellipse(ctx, x - width * .18, y - height * .56, width * .22, height * .15, '#a1a66b90', -.25);
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, tint = '#aa8556', open = false) {
  const half = width / 2;
  const lift = Math.max(4, width * .21);
  ellipse(ctx, x + 5, y + 2, half + 5, lift, '#26332763');
  polygon(ctx, [
    { x: x - half, y: y - height }, { x: x - half + 7, y: y - height - lift },
    { x: x + half + 5, y: y - height - lift }, { x: x + half, y: y - height },
  ], open ? '#41392f' : '#c49b64', '#5b4736');
  polygon(ctx, [
    { x: x + half, y: y - height }, { x: x + half + 5, y: y - height - lift },
    { x: x + half + 5, y: y - lift }, { x: x + half, y },
  ], '#715744');
  ctx.fillStyle = tint;
  ctx.fillRect(x - half, y - height, width, height);
  ctx.strokeStyle = '#614b37';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - half, y - height, width, height);
  line(ctx, { x: x - half + 1, y: y - height * .45 }, { x: x + half - 1, y: y - height * .45 }, '#6c553e75');
  line(ctx, { x: x - half + 4, y: y - height + 2 }, { x: x + half - 4, y: y - 2 }, '#d8b2846f', 2);
  if (!open) {
    ctx.fillStyle = '#ecd49b';
    ctx.fillRect(x - 3, y - height - 1, 6, 5);
  }
}

function fence(ctx: CanvasRenderingContext2D, a: Point, b: Point, palette: 'wood' | 'metal') {
  const face = palette === 'wood' ? '#80654a' : '#626b62';
  const light = palette === 'wood' ? '#b09166' : '#888979';
  for (const h of [14, 23]) {
    line(ctx, { x: a.x, y: a.y - h }, { x: b.x, y: b.y - h }, face, 6);
    line(ctx, { x: a.x, y: a.y - h - 2 }, { x: b.x, y: b.y - h - 2 }, light, 1.4);
  }
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const posts = Math.max(1, Math.ceil(length / 38));
  for (let i = 0; i <= posts; i++) {
    const x = a.x + (b.x - a.x) * i / posts;
    const y = a.y + (b.y - a.y) * i / posts;
    line(ctx, { x: x + 4, y: y + 2 }, { x: x + 13, y: y + 5 }, '#30362b58', 4);
    ctx.fillStyle = face;
    ctx.fillRect(x - 3, y - 30, 6, 29);
    ctx.fillStyle = light;
    ctx.fillRect(x - 3, y - 30, 2, 28);
  }
}

function lodge(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, depot: boolean) {
  const h = w * .47;
  const slope = w * .35;
  const left = x - w / 2;
  const right = x + w / 2;
  ellipse(ctx, x + 15, y + 1, w * .65, h * .35, '#29362c8a', -.05);
  polygon(ctx, [
    { x: right, y: y - h }, { x: right + slope * .43, y: y - h - slope * .66 },
    { x: right + slope * .43, y: y - slope * .66 }, { x: right, y },
  ], depot ? '#5a6158' : '#65503c');
  const facade = ctx.createLinearGradient(left, y - h, right, y);
  facade.addColorStop(0, depot ? '#929080' : '#b5895e');
  facade.addColorStop(1, depot ? '#70776b' : '#8d6449');
  ctx.fillStyle = facade;
  ctx.fillRect(left, y - h, w, h);
  for (let row = y - h + 7; row < y; row += 8) {
    line(ctx, { x: left, y: row }, { x: right, y: row }, depot ? '#4d574c57' : '#634d397b');
  }
  const roof = ctx.createLinearGradient(left, y - h - slope, right, y - h);
  roof.addColorStop(0, depot ? '#a3a296' : '#686f62');
  roof.addColorStop(1, depot ? '#5c655f' : '#434f47');
  const roofPoints = [
    { x: left - 9, y: y - h + 4 }, { x: x - 7, y: y - h - slope },
    { x: x + slope * .48, y: y - h - slope * 1.67 }, { x: right + slope * .52, y: y - h - slope * .65 }, { x: right + 10, y: y - h + 4 },
  ];
  polygon(ctx, roofPoints, roof, '#343e35');
  polygon(ctx, [roofPoints[0], roofPoints[1], { x: right + 10, y: y - h + 4 }], depot ? '#74766b' : '#555b4c', '#3c4339');
  for (let i = 0; i < 8; i++) {
    const t = i / 8;
    line(ctx, { x: x - 6 + (right + 10 - x + 6) * t, y: y - h - slope + (slope + 4) * t }, { x: x + slope * .48 + (right - x) * t, y: y - h - slope * 1.67 + slope * 1.02 * t }, '#d3cbaa38', 1.2);
  }
  const doorW = w * .24;
  ctx.fillStyle = depot ? '#4a524b' : '#44382b';
  ctx.fillRect(x - doorW / 2, y - h * .65, doorW, h * .65);
  ctx.strokeStyle = depot ? '#66685b' : '#c39a6a';
  ctx.strokeRect(x - doorW / 2, y - h * .65, doorW, h * .65);
  for (const sign of [-1, 1]) {
    const wx = x + sign * w * .3;
    if (!depot) glow(ctx, wx, y - h * .53, h * .45, '#f3b65d75');
    ctx.fillStyle = depot ? '#52655f' : '#f0c17b';
    ctx.fillRect(wx - 7, y - h * .69, 14, 13);
    ctx.strokeStyle = depot ? '#8b8776' : '#5b4530';
    ctx.strokeRect(wx - 7, y - h * .69, 14, 13);
    line(ctx, { x: wx, y: y - h * .69 }, { x: wx, y: y - h * .69 + 13 }, '#60533f', 1.5);
  }
  if (depot) {
    ctx.fillStyle = '#a36f52';
    ctx.fillRect(x - 9, y - h * .85, 18, 4);
  } else {
    ctx.fillStyle = '#bd9870';
    ctx.fillRect(x - doorW * .8, y - 3, doorW * 1.6, 6);
  }
}

function firepit(ctx: CanvasRenderingContext2D, x: number, y: number, time: number) {
  glow(ctx, x, y - 8, 57, '#f2ac4e59');
  ellipse(ctx, x, y + 1, 22, 13, '#625941');
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    stone(ctx, x + 20 * Math.cos(a), y + 8 * Math.sin(a), 7, 5);
  }
  line(ctx, { x: x - 10, y: y + 2 }, { x: x + 12, y: y - 2 }, '#5a4130', 5);
  line(ctx, { x: x - 7, y: y - 4 }, { x: x + 6, y: y + 4 }, '#624936', 5);
  const pulse = Math.sin(time / 105) * 3;
  polygon(ctx, [{ x: x - 9, y: y - 2 }, { x: x - 5, y: y - 18 }, { x: x + 1, y: y - 13 }, { x: x + 6, y: y - 26 - pulse }, { x: x + 9, y: y - 3 }, { x, y: y + 2 }], '#e58d4f');
  polygon(ctx, [{ x: x - 5, y: y - 1 }, { x: x + 2, y: y - 13 - pulse * .5 }, { x: x + 5, y: y - 3 }, { x, y: y + 1 }], '#f4cf8a');
  for (let i = 0; i < 4; i++) {
    const rise = (time / (72 + i * 8) + i * 10) % 35;
    ellipse(ctx, x + Math.sin(i * 6 + rise / 9) * 12, y - 10 - rise, 1.1, 1.5, `rgba(255,197,105,${(35 - rise) / 45})`);
  }
}

function environment(kind: RoomKind, map: MapSpec): { ground: HTMLCanvasElement; props: Prop[] } {
  const background = document.createElement('canvas');
  background.width = GROUND.width;
  background.height = GROUND.height;
  const ctx = background.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  ctx.translate(-GROUND.x, -GROUND.y);
  const depot = kind === 'field';
  const rng = seeded(kind === 'tutorial' ? 2267 : kind === 'hub' ? 8897 : 3027);
  const terrain = ctx.createLinearGradient(0, -280, WIDTH * .8, HEIGHT * TILT + 260);
  terrain.addColorStop(0, depot ? '#7e8470' : '#889579');
  terrain.addColorStop(.45, depot ? '#747961' : '#87946b');
  terrain.addColorStop(1, depot ? '#4f5a4e' : '#566b51');
  ctx.fillStyle = terrain;
  ctx.fillRect(GROUND.x, GROUND.y, GROUND.width, GROUND.height);

  for (let layer = 0; layer < 4; layer++) {
    const base = -210 + layer * 47;
    const height = 70 + layer * 19;
    const points: Point[] = [{ x: GROUND.x, y: base + 65 }];
    for (let x = GROUND.x; x <= GROUND.x + GROUND.width; x += 72) {
      points.push({ x, y: base - Math.sin((x + layer * 80) / 147) * height * .49 - rng() * height });
    }
    points.push({ x: GROUND.x + GROUND.width, y: base + 135 }, { x: GROUND.x, y: base + 135 });
    const ridge = ctx.createLinearGradient(0, base - height, 0, base + 135);
    const tone = (depot ? ['#a2a68e', '#979d85', '#8b9179', '#7f8b70'] : ['#b5b89b', '#a4ad8e', '#9fa98a', '#909d7b'])[layer];
    ridge.addColorStop(0, tone);
    ridge.addColorStop(.58, tone + 'bc');
    ridge.addColorStop(1, tone + '00');
    polygon(ctx, points, ridge);
  }

  for (let i = 0; i < 106; i++) {
    const x = GROUND.x + rng() * GROUND.width;
    const y = -124 + rng() * (HEIGHT * TILT + 237);
    const r = 27 + rng() * 115;
    const mist = ctx.createRadialGradient(x, y, 4, x, y, r);
    mist.addColorStop(0, ['#c9bc8247', '#4564483b', '#c6c69b4e', '#46574634', '#77936647'][i % 5]);
    mist.addColorStop(1, 'transparent');
    ellipse(ctx, x, y, r, r * (.28 + rng() * .45), mist, rng() * .35);
  }

  for (let i = 0; i < 2450; i++) {
    const x = GROUND.x + rng() * GROUND.width;
    const y = -170 + rng() * (HEIGHT * TILT + 400);
    const p = { x: x - (y / TILT - HEIGHT / 2) * SHEAR, y: y / TILT };
    if (inPath(p, map.paths, 29)) continue;
    const r = .45 + rng() * 3.3;
    const tint = ['#d5c99a5b', '#e3d3a43e', '#4c67434b', '#3c55443d', '#a6a56d70'][i % 5];
    if (i % 5 === 0) grass(ctx, x, y, r + 1.3, tint);
    else ellipse(ctx, x, y, r, r * .36, tint, .12);
  }

  const light = ctx.createLinearGradient(0, 0, 0, HEIGHT * TILT);
  light.addColorStop(0, depot ? '#ad9e7a' : '#b9ac78');
  light.addColorStop(1, depot ? '#969070' : '#a3a470');
  for (const path of map.paths) {
    tracePath(ctx, path, '#4d5a3b26', 63);
    tracePath(ctx, path, '#c1ac7765', 53);
    tracePath(ctx, path, light, 43);
    tracePath(ctx, path, '#d8c49461', 33);
  }
  for (let i = 0; i < 1100; i++) {
    const p = { x: rng() * WIDTH, y: rng() * HEIGHT };
    if (!inPath(p, map.paths, 28)) continue;
    const { x, y } = project(p);
    const tint = ['#e6d6ab72', '#887a5b54', '#f0dba04c', '#a0915f6b'][i % 4];
    ellipse(ctx, x, y, .6 + rng() * 2.3, .4 + rng() * 1.2, tint, -.2);
  }

  const props: Prop[] = [];
  const addTree = (x: number, y: number, scale: number) => {
    const height = (46 + rng() * 72) * scale;
    const sway = rng() * 17 - 8.5;
    const shade = Math.floor(rng() * 4);
    const view = project({ x, y });
    props.push({ depth: y, paint: (target) => pine(target, view.x, view.y, height, sway, shade) });
  };
  for (let i = 0; i < 102; i++) {
    const x = -155 + rng() * (WIDTH + 310);
    const y = i < 64 ? -80 + rng() * 122 : HEIGHT - 24 + rng() * 112;
    if (!inPath({ x, y }, map.paths, 59) && (i < 64 || x < 235 || x > WIDTH - 190 || y > HEIGHT + 31)) addTree(x, y, y > HEIGHT ? .98 : .84);
  }
  for (let i = 0; i < 36; i++) {
    const x = i < 18 ? -110 + rng() * 146 : WIDTH - 30 + rng() * 158;
    const y = 25 + rng() * (HEIGHT - 52);
    if (!inPath({ x, y }, map.paths, 62)) addTree(x, y, .94);
  }

  for (let i = 0; i < 96; i++) {
    const p = { x: 18 + rng() * (WIDTH - 36), y: 40 + rng() * (HEIGHT - 80) };
    if (inPath(p, map.paths, 44)) continue;
    const { x, y } = project(p);
    if (i % 5 === 0) stone(ctx, x, y, 6 + rng() * 9, 3 + rng() * 5, true);
    else {
      ellipse(ctx, x, y + 1, 8, 2.8, '#4f633e51');
      grass(ctx, x, y, 4.5 + rng() * 5, '#b9bd7f94');
    }
  }

  for (const obstacle of map.obstacles) {
    const point = { x: obstacle.x + obstacle.w * .5, y: obstacle.y + obstacle.h };
    const p = project(point);
    let paint: Paint;
    if (obstacle.kind === 'tree') {
      const height = 51 + Math.max(obstacle.w, obstacle.h) * .97;
      const sway = rng() * 14 - 7;
      const shade = Math.floor(rng() * 4);
      paint = (target) => pine(target, p.x, p.y, height, sway, shade);
    } else if (obstacle.kind === 'rock') {
      paint = (target) => stone(target, p.x, p.y, obstacle.w, obstacle.h * .64 + 6, !depot);
    } else if (obstacle.kind === 'crate') {
      paint = (target) => box(target, p.x, p.y, obstacle.w * .82, obstacle.h * .5, depot ? '#827968' : '#a78559');
    } else if (obstacle.w > 75 && obstacle.h > 48) {
      paint = (target) => lodge(target, p.x, p.y, obstacle.w * .95, depot);
    } else {
      const horizontal = obstacle.w >= obstacle.h;
      const start = project({ x: obstacle.x, y: horizontal ? point.y : obstacle.y });
      const end = project({ x: horizontal ? obstacle.x + obstacle.w : obstacle.x, y: point.y });
      paint = (target) => fence(target, start, end, depot ? 'metal' : 'wood');
    }
    props.push({ depth: point.y, paint });
  }

  return { ground: background, props };
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, accent = '#f4dfb5') {
  ctx.font = '600 11px "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 16;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 9, w, 18, 5);
  ctx.fillStyle = '#2b3529e8';
  ctx.fill();
  ctx.strokeStyle = '#b9ab7987';
  ctx.lineWidth = .65;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillText(text, x, y);
}

function sign(ctx: CanvasRenderingContext2D, point: Point, text: string, active: boolean, time: number, color = '#d9ba80') {
  const { x, y } = project(point);
  const wave = .5 + Math.sin(time / 420) * .15;
  glow(ctx, x, y, 32, active ? '#ffe0a58a' : '#f6d99642');
  ellipse(ctx, x, y + 1, 22, 10, active ? '#d7bb7166' : '#737c4d63');
  ctx.beginPath();
  ctx.ellipse(x, y, 20, 9, 0, 0, Math.PI * 2);
  ctx.strokeStyle = active ? '#ffe7a8' : `rgba(255,220,151,${wave})`;
  ctx.lineWidth = active ? 1.7 : 1;
  ctx.stroke();
  line(ctx, { x, y: y + 1 }, { x, y: y - 29 }, '#654e38', 5);
  polygon(ctx, [
    { x: x - 14, y: y - 28 }, { x: x + 9, y: y - 28 }, { x: x + 16, y: y - 23 }, { x: x + 9, y: y - 18 }, { x: x - 14, y: y - 18 },
  ], color, '#72543a');
  line(ctx, { x: x - 8, y: y - 23 }, { x: x + 7, y: y - 23 }, '#5a5137', 1.2);
  label(ctx, x, y - 42, text);
}

function crossTarget(ctx: CanvasRenderingContext2D, point: Point, hit: boolean) {
  const { x, y } = project(point);
  ellipse(ctx, x + 6, y + 2, 17, 6, '#2f392957');
  line(ctx, { x: x - 9, y }, { x: x - 5, y: y - 22 }, '#6b5138', 4);
  line(ctx, { x: x + 8, y }, { x: x + 5, y: y - 22 }, '#6b5138', 4);
  ellipse(ctx, x, y - 23, 15, 12, '#c4ac7a');
  ellipse(ctx, x, y - 23, 11.3, 9.1, hit ? '#728061' : '#9a634f');
  ellipse(ctx, x, y - 23, 7.7, 6.5, '#dfcb9a');
  ellipse(ctx, x, y - 23, 3.4, 2.8, hit ? '#6f8c64' : '#a35d47');
  label(ctx, x, y - 49, hit ? '사격 완료' : '연습 표적');
}

function drawActor(ctx: CanvasRenderingContext2D, actor: Actor, x: number, y: number, self: boolean, hostile: boolean, moving: boolean, time: number) {
  if (!actor.connected && !hostile) ctx.globalAlpha = .6;
  if (actor.hp <= 0) ctx.globalAlpha = .33;
  ellipse(ctx, x + 3, y + 1, hostile ? 12 : 13, 6.1, '#242f255f');
  if (self) {
    ellipse(ctx, x, y, 16, 8, '#dfbc7670');
    ctx.beginPath();
    ctx.ellipse(x, y, 15, 7, 0, 0, Math.PI * 2);
    ctx.strokeStyle = '#f1d292';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  const stride = moving ? Math.sin(time / 87) * 3 : 0;
  const lift = moving ? Math.abs(Math.sin(time / 87)) * 1.9 : 0;
  const sy = y - lift;
  ellipse(ctx, x - 4, sy - 1 + stride, 3.7, 2.6, '#3d3f33');
  ellipse(ctx, x + 4, sy - 1 - stride, 3.7, 2.6, '#3d3f33');
  const coat = ctx.createLinearGradient(x - 8, sy - 17, x + 10, sy - 5);
  coat.addColorStop(0, hostile ? '#b58169' : self ? '#d3aa65' : '#a0a981');
  coat.addColorStop(1, hostile ? '#754f48' : self ? '#9b7248' : '#646f57');
  ellipse(ctx, x, sy - 10, 9, 9.7, coat);
  ellipse(ctx, x - 6.5, sy - 10, 4.3, 6.3, hostile ? '#554a45' : '#667054', .25);
  const aimX = Math.cos(actor.aim);
  const aimY = Math.sin(actor.aim);
  const z = { x: x + aimX * 15, y: sy - 10 + aimY * 10 };
  line(ctx, { x: x + aimX * 5, y: sy - 10 + aimY * 3 }, z, hostile ? '#4c4942' : '#4d4a36', 3.1);
  line(ctx, { x: x + aimX * 7, y: sy - 11 + aimY * 5 }, { x: z.x, y: z.y - 1 }, '#c4aa7a', .9);
  const skin = hostile ? '#c09a7d' : '#e5c49b';
  ellipse(ctx, x + aimX * 1.5, sy - 20, 7.7, 7.2, skin);
  ellipse(ctx, x - 1.5, sy - 23, 8.4, 4.9, hostile ? '#635e54' : self ? '#53674e' : '#77745b', -.12);
  line(ctx, { x: x - 8.5, y: sy - 22 }, { x: x + 8.8, y: sy - 21 }, hostile ? '#50483e' : '#3f5140', 1.35);
  ellipse(ctx, x + 2.8 + aimX, sy - 19.4, .95, 1, '#483d31');
  if (self || hostile || moving) {
    const name = hostile ? '보급소 경비' : self ? '나' : actor.name;
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const width = ctx.measureText(name).width + 10;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, sy - 41, width, 12, 3);
    ctx.fillStyle = '#29352ad7';
    ctx.fill();
    ctx.fillStyle = hostile ? '#f0ad8e' : '#f3e7c5';
    ctx.fillText(name, x, sy - 32);
  }
  ctx.globalAlpha = 1;
}

export class WorldRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private ratio = 1;
  private zoom = 1;
  private offset: Point = { x: 0, y: 0 };
  private camera: Point | null = null;
  private room: RoomKind = 'tutorial';
  private scenery = environment(this.room, MAPS[this.room]);
  private readonly actorPositions = new Map<string, Point>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable');
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.zoom = Math.max(.8, Math.min(1.55, this.width / 1080, this.height / 650));
  }

  toWorld(clientX: number, clientY: number, elevation = 0): Point {
    const rect = this.canvas.getBoundingClientRect();
    const y = ((clientY - rect.top - this.offset.y) / this.zoom + elevation) / TILT;
    return { x: (clientX - rect.left - this.offset.x) / this.zoom - (y - HEIGHT / 2) * SHEAR, y };
  }

  render(state: Snapshot | null, focus: Point | null, time: number, cursor: Point | null) {
    const nextRoom = state?.room ?? 'tutorial';
    if (nextRoom !== this.room) {
      this.room = nextRoom;
      this.scenery = environment(this.room, MAPS[this.room]);
      this.actorPositions.clear();
      this.camera = null;
    }
    const map = MAPS[this.room];
    const ctx = this.ctx;
    const self = state?.players.find((actor) => actor.id === state.self);
    const point = project(self ?? map.spawn);
    const horizontalRadius = this.width / this.zoom * .5;
    const verticalRadius = this.height / this.zoom * .5;
    const center = {
      x: horizontalRadius > WIDTH / 2 ? WIDTH / 2 : Math.max(horizontalRadius * .66, Math.min(WIDTH - horizontalRadius * .66, point.x)),
      y: this.width < 650
        ? HEIGHT * TILT * .46 + (point.y - HEIGHT * TILT * .46) * .58
        : verticalRadius > HEIGHT * TILT * .56 ? HEIGHT * TILT * .46 : point.y,
    };
    this.camera ??= center;
    this.camera.x += (center.x - this.camera.x) * .13;
    this.camera.y += (center.y - this.camera.y) * .13;
    this.offset = { x: this.width / 2 - this.camera.x * this.zoom, y: this.height / 2 - this.camera.y * this.zoom };
    const projection = { zoom: this.zoom, offsetX: this.offset.x, offsetY: this.offset.y };
    for (const [key, value] of Object.entries(projection)) {
      const attribute = value.toFixed(4);
      if (this.canvas.dataset[key] !== attribute) this.canvas.dataset[key] = attribute;
    }
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.fillStyle = '#77836b';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.zoom, this.zoom);
    ctx.drawImage(this.scenery.ground, GROUND.x, GROUND.y);

    const props = [...this.scenery.props];
    const focusOn = (p: Point) => !!focus && focus.x === p.x && focus.y === p.y;
    props.push({ depth: map.exit.y, paint: (target) => sign(target, map.exit, map.exit.label, focusOn(map.exit), time, this.room === 'field' ? '#a6b78b' : undefined) });
    if (map.target) {
      const target = map.target;
      props.push({ depth: target.y, paint: (canvas) => crossTarget(canvas, target, state?.tutorial.shot ?? false) });
    }
    if (map.stash) {
      const stash = map.stash;
      const p = project(stash);
      props.push({ depth: stash.y, paint: (target) => {
        if (focusOn(stash)) glow(target, p.x, p.y - 5, 26, '#f2cd7cae');
        box(target, p.x, p.y, 35, 19, '#8b784f');
        label(target, p.x, p.y - 40, '보관함');
      } });
    }
    if (this.room !== 'field') {
      const fire = this.room === 'hub' ? { x: 494, y: 358 } : { x: 388, y: 292 };
      const p = project(fire);
      props.push({ depth: fire.y, paint: (target) => firepit(target, p.x, p.y, time) });
      if (this.room === 'tutorial') {
        const shelter = { x: 464, y: 174 };
        const base = project(shelter);
        props.push({ depth: shelter.y, paint: (target) => lodge(target, base.x, base.y, 122, false) });
      }
    }
    for (const item of state?.loot ?? []) {
      const p = project(item);
      props.push({ depth: item.y, paint: (target) => {
        if (item.available) {
          const highlight = focusOn(item);
          glow(target, p.x, p.y - 5, highlight ? 37 : 21, highlight ? '#ffdb91a9' : '#eec68453');
          box(target, p.x, p.y, 27, 14, supplyColors[item.supply]);
          if (highlight) label(target, p.x, p.y - 32, '물자 상자');
        } else {
          box(target, p.x, p.y, 25, 10, '#807556', true);
        }
      } });
    }

    const shown = new Set<string>();
    for (const group of [{ actors: state?.players ?? [], hostile: false }, { actors: state?.enemies ?? [], hostile: true }]) {
      for (const actor of group.actors) {
        if (actor.id === 'target' && this.room === 'tutorial') continue;
        const p = project(actor);
        const current = this.actorPositions.get(actor.id) ?? p;
        const speed = Math.hypot(p.x - current.x, p.y - current.y);
        current.x += (p.x - current.x) * (speed > 220 ? 1 : .22);
        current.y += (p.y - current.y) * (speed > 220 ? 1 : .22);
        this.actorPositions.set(actor.id, current);
        shown.add(actor.id);
        props.push({ depth: actor.y, paint: (target) => drawActor(target, actor, current.x, current.y, actor.id === state?.self, group.hostile, speed > .9, time) });
      }
    }
    for (const id of this.actorPositions.keys()) if (!shown.has(id)) this.actorPositions.delete(id);

    props.sort((a, b) => a.depth - b.depth);
    for (const prop of props) prop.paint(ctx);
    for (const shot of state?.shots ?? []) {
      const from = project(shot);
      const to = project({ x: shot.toX, y: shot.toY });
      const tracer = shot.enemy ? '#ed9b78' : '#f7db8d';
      line(ctx, { x: from.x, y: from.y - AIM_ELEVATION }, { x: to.x, y: to.y - AIM_ELEVATION }, tracer + '51', 5);
      line(ctx, { x: from.x, y: from.y - AIM_ELEVATION }, { x: to.x, y: to.y - AIM_ELEVATION }, tracer, 1.35);
      glow(ctx, from.x, from.y - 10, 12, '#fff2ab98');
    }
    if (cursor && self && this.room !== 'hub') {
      const p = project(cursor);
      p.y -= AIM_ELEVATION;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffebbe8c';
      ctx.lineWidth = .8;
      ctx.stroke();
      line(ctx, { x: p.x - 3, y: p.y }, { x: p.x + 3, y: p.y }, '#fff0cc9f');
      line(ctx, { x: p.x, y: p.y - 3 }, { x: p.x, y: p.y + 3 }, '#fff0cc9f');
    }
  }
}

// Endless mode: random boards that are only accepted when the solver can clear them.
import { COLOR_ORDER, parseLevel, buildOcc, findExit } from './logic.js';
import { solve } from './solver.js';

const SHAPES = [
  [[0, 0]],
  [[0, 0], [1, 0]],
  [[0, 0], [0, 1]],
  [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [0, 1], [0, 2]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[0, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [0, 1]],
  [[1, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [0, 2], [1, 2]],
  [[0, 0], [1, 0], [2, 0], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
  [[0, 0], [1, 0], [2, 0], [0, 1]],
];
const TAGS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SIDE_NAMES = ['top', 'bottom', 'left', 'right'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function shuffle(r, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function tryBuild(stage, r) {
  const w = 5 + Math.min(2, Math.floor(stage / 4));
  const h = w + (r() < 0.5 ? 1 : 0);
  const nColors = Math.min(6, 3 + Math.floor(stage / 2));
  const target = Math.min(11, 5 + stage);
  const grid = Array.from({ length: h }, () => Array(w).fill('.'));

  if (stage >= 3) {
    const corners = shuffle(r, [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]);
    const n = Math.floor(r() * 3);
    for (let i = 0; i < n; i++) grid[corners[i][1]][corners[i][0]] = '#';
  }

  const placed = [];
  for (let t = 0; t < 300 && placed.length < target; t++) {
    const shape = pick(r, SHAPES);
    const sw = Math.max(...shape.map((c) => c[0])) + 1;
    const sh = Math.max(...shape.map((c) => c[1])) + 1;
    const x = Math.floor(r() * (w - sw + 1));
    const y = Math.floor(r() * (h - sh + 1));
    if (!shape.every(([dx, dy]) => grid[y + dy][x + dx] === '.')) continue;
    const tag = TAGS[placed.length];
    for (const [dx, dy] of shape) grid[y + dy][x + dx] = tag;
    placed.push({ tag, x, y, sw, sh, props: {} });
  }
  if (placed.length < target - 1) return null;

  const colors = shuffle(r, [...COLOR_ORDER]).slice(0, nColors);
  shuffle(r, placed).forEach((p, i) => (p.props.color = colors[i % colors.length]));

  if (stage >= 3) {
    const layered = shuffle(r, [...placed]).slice(0, stage >= 6 ? 2 : 1);
    for (const p of layered) p.props.layers = [pick(r, colors.filter((c) => c !== p.props.color))];
  }

  // One door per color, wide enough for every block that will ever wear that color.
  const used = { top: [], bottom: [], left: [], right: [] };
  const doors = [];
  for (const c of colors) {
    const group = placed.filter((p) => p.props.color === c || p.props.layers?.includes(c));
    if (!group.length) continue;
    let made = false;
    for (const side of shuffle(r, [...SIDE_NAMES])) {
      const horizontal = side === 'top' || side === 'bottom';
      const sideLen = horizontal ? w : h;
      const need = Math.max(...group.map((p) => (horizontal ? p.sw : p.sh)));
      const len = Math.min(sideLen, need + (r() < 0.3 ? 1 : 0));
      const starts = shuffle(r, Array.from({ length: sideLen - len + 1 }, (_, i) => i));
      for (const at of starts) {
        const clash = used[side].some(([a, l]) => at < a + l && a < at + len);
        if (clash) continue;
        let walled = false;
        for (let k = at; k < at + len; k++) {
          const [cx, cy] = side === 'top' ? [k, 0] : side === 'bottom' ? [k, h - 1] : side === 'left' ? [0, k] : [w - 1, k];
          if (grid[cy][cx] === '#') walled = true;
        }
        if (walled) continue;
        used[side].push([at, len]);
        doors.push({ side, at, len, color: c });
        made = true;
        break;
      }
      if (made) break;
    }
    if (!made) return null;
  }

  // Arrow blocks only where a door of their color lines up with their lane.
  if (stage >= 1) {
    for (const p of placed) {
      if (p.props.layers || r() > 0.25) continue;
      for (const d of doors) {
        if (d.color !== p.props.color) continue;
        if ((d.side === 'left' || d.side === 'right') && p.y >= d.at && p.y + p.sh <= d.at + d.len) p.props.axis = 'h';
        if ((d.side === 'top' || d.side === 'bottom') && p.x >= d.at && p.x + p.sw <= d.at + d.len) p.props.axis = 'v';
      }
    }
  }
  if (stage >= 2) {
    const p = pick(r, placed);
    p.props.ice = 1 + Math.floor(r() * Math.min(3, placed.length - 2));
  }
  if (stage >= 4 && r() < 0.6) {
    const [a, b] = shuffle(r, placed.filter((p) => !p.props.ice));
    if (a && b) {
      a.props.lock = true;
      b.props.key = true;
    }
  }

  const blocks = {};
  for (const p of placed) blocks[p.tag] = p.props;
  return {
    name: `Endless ${stage + 1}`,
    time: 45 + placed.length * 12,
    grid: grid.map((row) => row.join('')),
    blocks,
    doors,
  };
}

export function generateLevel(stage, seed = Date.now()) {
  const r = mulberry32(seed ^ (stage * 2654435761));
  for (let attempt = 0; attempt < 80; attempt++) {
    const def = tryBuild(stage, r);
    if (!def) continue;
    const { level, blocks } = parseLevel(def);
    const occ = buildOcc(level, blocks);
    if (blocks.some((b) => findExit(level, occ, b) >= 0)) continue;
    const res = solve(level, blocks, { maxStates: 20000 });
    if (res.solvable && res.moves >= blocks.length * 2) return def;
  }
  return null;
}

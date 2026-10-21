// Game rules shared by the server (authoritative), the browser (prediction) and the solver.

export const PALETTE = {
  red:    { base: '#ef4444', dark: '#a61b1b', light: '#fca5a5', glyph: '●' },
  blue:   { base: '#3b82f6', dark: '#1d4ed8', light: '#93c5fd', glyph: '■' },
  green:  { base: '#22c55e', dark: '#15803d', light: '#86efac', glyph: '▲' },
  yellow: { base: '#facc15', dark: '#b88a04', light: '#fef08a', glyph: '◆' },
  purple: { base: '#a855f7', dark: '#7322b5', light: '#d8b4fe', glyph: '★' },
  orange: { base: '#f97316', dark: '#c2410c', light: '#fdba74', glyph: '✚' },
  cyan:   { base: '#06b6d4', dark: '#0e7490', light: '#67e8f9', glyph: '⬢' },
  pink:   { base: '#ec4899', dark: '#be185d', light: '#f9a8d4', glyph: '♥' },
};
export const COLOR_ORDER = Object.keys(PALETTE);

export const SIDES = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

export const EMOTES = ['👍', 'Wait!', 'Go!', 'Help?', 'Nice!', 'Oops'];

// A level definition is authored as an ASCII grid: '.' empty, '#' wall, any other
// character is one block (all cells sharing that character). Block properties live
// in def.blocks keyed by that character.
export function parseLevel(def, index = 0) {
  const h = def.grid.length;
  const w = def.grid[0].length;
  const walls = new Array(w * h).fill(0);
  const cellsByTag = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = def.grid[y][x];
      if (ch === '#') walls[y * w + x] = 1;
      else if (ch !== '.') {
        if (!cellsByTag.has(ch)) cellsByTag.set(ch, []);
        cellsByTag.get(ch).push([x, y]);
      }
    }
  }
  const blocks = [];
  for (const [tag, cells] of cellsByTag) {
    const p = def.blocks?.[tag];
    if (!p || !PALETTE[p.color]) throw new Error(`Level "${def.name}": block ${tag} has no valid color`);
    const minX = Math.min(...cells.map((c) => c[0]));
    const minY = Math.min(...cells.map((c) => c[1]));
    blocks.push({
      id: blocks.length,
      tag,
      x: minX,
      y: minY,
      cells: cells.map(([cx, cy]) => [cx - minX, cy - minY]),
      color: p.color,
      layers: p.layers ? [...p.layers] : [],
      ice: p.ice ?? 0,
      axis: p.axis ?? null,
      lock: !!p.lock,
      hasKey: !!p.key,
      gone: false,
    });
  }
  const level = {
    index,
    name: def.name,
    hint: def.hint ?? null,
    w,
    h,
    time: def.time ?? 90,
    walls,
    doors: def.doors.map((d) => ({ ...d })),
  };
  return { level, blocks };
}

export function cloneBlocks(blocks) {
  return blocks.map((b) => ({ ...b, layers: [...b.layers] }));
}

export function buildOcc(level, blocks) {
  const occ = new Int16Array(level.w * level.h);
  for (let i = 0; i < occ.length; i++) if (level.walls[i]) occ[i] = -1;
  for (const b of blocks) {
    if (b.gone) continue;
    for (const [dx, dy] of b.cells) occ[(b.y + dy) * level.w + (b.x + dx)] = b.id + 1;
  }
  return occ;
}

export function canPlace(level, occ, b, nx, ny) {
  for (const [dx, dy] of b.cells) {
    const cx = nx + dx;
    const cy = ny + dy;
    if (cx < 0 || cy < 0 || cx >= level.w || cy >= level.h) return false;
    const v = occ[cy * level.w + cx];
    if (v !== 0 && v !== b.id + 1) return false;
  }
  return true;
}

export function keysLeft(blocks) {
  return blocks.some((b) => !b.gone && b.hasKey);
}

// Why a block cannot be moved right now, or null if it can.
export function moveBlocker(blocks, b) {
  if (!b || b.gone) return 'gone';
  if (b.ice > 0) return 'ice';
  if (b.lock && keysLeft(blocks)) return 'lock';
  return null;
}

export function canStep(level, occ, blocks, b, dx, dy) {
  if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
  if (moveBlocker(blocks, b)) return false;
  if (b.axis === 'h' && dy !== 0) return false;
  if (b.axis === 'v' && dx !== 0) return false;
  return canPlace(level, occ, b, b.x + dx, b.y + dy);
}

export function moveStep(occ, level, b, dx, dy) {
  for (const [cx, cy] of b.cells) occ[(b.y + cy) * level.w + (b.x + cx)] = 0;
  b.x += dx;
  b.y += dy;
  for (const [cx, cy] of b.cells) occ[(b.y + cy) * level.w + (b.x + cx)] = b.id + 1;
}

export function bounds(b) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [dx, dy] of b.cells) {
    const x = b.x + dx, y = b.y + dy;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

function pathClear(level, occ, b, [sx, sy]) {
  for (const [dx, dy] of b.cells) {
    let x = b.x + dx + sx;
    let y = b.y + dy + sy;
    while (x >= 0 && y >= 0 && x < level.w && y < level.h) {
      const v = occ[y * level.w + x];
      if (v !== 0 && v !== b.id + 1) return false;
      x += sx;
      y += sy;
    }
  }
  return true;
}

// A block leaves through a door of its color when it touches that edge, its whole
// width fits inside the door span, and nothing sits between it and the edge.
export function findExit(level, occ, b) {
  if (b.gone || b.ice > 0) return -1;
  const { minX, maxX, minY, maxY } = bounds(b);
  for (let i = 0; i < level.doors.length; i++) {
    const d = level.doors[i];
    if (d.color !== b.color) continue;
    const lo = d.at;
    const hi = d.at + d.len - 1;
    let ok = false;
    if (d.side === 'left') ok = minX === 0 && minY >= lo && maxY <= hi;
    else if (d.side === 'right') ok = maxX === level.w - 1 && minY >= lo && maxY <= hi;
    else if (d.side === 'top') ok = minY === 0 && minX >= lo && maxX <= hi;
    else if (d.side === 'bottom') ok = maxY === level.h - 1 && minX >= lo && maxX <= hi;
    if (ok && pathClear(level, occ, b, SIDES[d.side])) return i;
  }
  return -1;
}

// Removes the block (or peels its outer layer) and thaws frozen blocks by one.
// Returns true when only a layer was peeled and the block stays on the board.
export function applyExit(level, occ, blocks, b) {
  let peeled = false;
  if (b.layers.length) {
    b.color = b.layers.shift();
    peeled = true;
  } else {
    b.gone = true;
    for (const [dx, dy] of b.cells) occ[(b.y + dy) * level.w + (b.x + dx)] = 0;
  }
  for (const o of blocks) if (o !== b && !o.gone && o.ice > 0) o.ice--;
  return peeled;
}

// Runs every exit the block qualifies for (a peeled block may fit another door).
export function resolveExits(level, occ, blocks, b) {
  const events = [];
  let door;
  while (!b.gone && (door = findExit(level, occ, b)) >= 0) {
    const color = b.color;
    const peeled = applyExit(level, occ, blocks, b);
    events.push({ kind: 'exit', id: b.id, door, color, peeled, x: b.x, y: b.y });
  }
  return events;
}

export function isWon(blocks) {
  return blocks.every((b) => b.gone);
}

export function blockAt(level, blocks, x, y) {
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return null;
  for (const b of blocks) {
    if (b.gone) continue;
    for (const [dx, dy] of b.cells) if (b.x + dx === x && b.y + dy === y) return b;
  }
  return null;
}

export function levelColors(blocks) {
  const set = new Set();
  for (const b of blocks) {
    if (b.gone) continue;
    set.add(b.color);
    for (const l of b.layers) set.add(l);
  }
  return COLOR_ORDER.filter((c) => set.has(c));
}

// Split-control co-op: each player owns a share of the colors on the board.
export function assignColors(colors, playerIds) {
  const owners = {};
  if (playerIds.length < 2) return owners;
  colors.forEach((c, i) => {
    owners[c] = playerIds[i % playerIds.length];
  });
  return owners;
}

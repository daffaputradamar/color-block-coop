// Best-first search over single-cell moves; a solution comes back as path: [blockId, dx, dy][]. Used to prove levels are solvable
// (handcrafted ones in scripts/verify-levels.js, generated ones at runtime).
// Mirrors the rules in logic.js on a compact state: per block [x, y, exitsDone].
// Frozen counters need no storage: a block's ice is ice0 minus total exits so far.

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function solve(level, startBlocks, { maxStates = 400000 } = {}) {
  const { w, h, walls, doors } = level;
  const n = startBlocks.length;
  const info = startBlocks.map((b) => {
    let maxDx = 0, maxDy = 0;
    for (const [dx, dy] of b.cells) {
      maxDx = Math.max(maxDx, dx);
      maxDy = Math.max(maxDy, dy);
    }
    return {
      cells: b.cells,
      maxDx,
      maxDy,
      colors: [b.color, ...b.layers],
      ice: b.ice,
      axis: b.axis,
      lock: b.lock,
      hasKey: b.hasKey,
    };
  });
  const totalExits = info.reduce((s, b) => s + b.colors.length, 0);

  const start = new Int8Array(n * 3);
  startBlocks.forEach((b, i) => {
    start[i * 3] = b.x;
    start[i * 3 + 1] = b.y;
    start[i * 3 + 2] = b.gone ? info[i].colors.length : 0;
  });

  const occ = new Int16Array(w * h);
  const fillOcc = (s) => {
    for (let k = 0; k < occ.length; k++) occ[k] = walls[k] ? -1 : 0;
    for (let i = 0; i < n; i++) {
      if (s[i * 3 + 2] >= info[i].colors.length) continue;
      const x = s[i * 3], y = s[i * 3 + 1];
      for (const [dx, dy] of info[i].cells) occ[(y + dy) * w + x + dx] = i + 1;
    }
  };

  // Door check for block i sitting at (x, y); its own old cells count as free.
  const exitDoor = (i, x, y, color) => {
    const b = info[i];
    const minX = x, maxX = x + b.maxDx, minY = y, maxY = y + b.maxDy;
    for (const d of doors) {
      if (d.color !== color) continue;
      const lo = d.at, hi = d.at + d.len - 1;
      let sx = 0, sy = 0, ok = false;
      if (d.side === 'left') { ok = minX === 0 && minY >= lo && maxY <= hi; sx = -1; }
      else if (d.side === 'right') { ok = maxX === w - 1 && minY >= lo && maxY <= hi; sx = 1; }
      else if (d.side === 'top') { ok = minY === 0 && minX >= lo && maxX <= hi; sy = -1; }
      else { ok = maxY === h - 1 && minX >= lo && maxX <= hi; sy = 1; }
      if (!ok) continue;
      let clear = true;
      for (const [dx, dy] of b.cells) {
        let cx = x + dx + sx, cy = y + dy + sy;
        while (clear && cx >= 0 && cy >= 0 && cx < w && cy < h) {
          const v = occ[cy * w + cx];
          if (v !== 0 && v !== i + 1) clear = false;
          cx += sx;
          cy += sy;
        }
        if (!clear) break;
      }
      if (clear) return true;
    }
    return false;
  };

  const keyOf = (s) => String.fromCharCode.apply(null, s);
  const seen = new Set([keyOf(start)]);
  const buckets = [];
  const heads = [];
  // Each node remembers its parent and the step that produced it, so a solution can be replayed.
  const push = (node) => {
    const p = totalExits - node.exits;
    if (!buckets[p]) {
      buckets[p] = [];
      heads[p] = 0;
    }
    buckets[p].push(node);
  };
  push({ s: start, depth: 0, exits: start.reduce((acc, v, k) => (k % 3 === 2 ? acc + v : acc), 0), parent: null, step: null });
  let states = 1;

  for (;;) {
    let p = 0;
    while (p < buckets.length && !(buckets[p] && heads[p] < buckets[p].length)) p++;
    if (p >= buckets.length) return { solvable: false, states, complete: true };
    const node = buckets[p][heads[p]];
    buckets[p][heads[p]++] = null;
    if (p === 0) {
      const path = [];
      for (let k = node; k.step; k = k.parent) path.push(k.step);
      return { solvable: true, moves: node.depth, states, path: path.reverse() };
    }
    const s = node.s;
    fillOcc(s);
    let keys = false;
    for (let i = 0; i < n; i++) if (info[i].hasKey && s[i * 3 + 2] < info[i].colors.length) keys = true;

    for (let i = 0; i < n; i++) {
      const b = info[i];
      const stage = s[i * 3 + 2];
      if (stage >= b.colors.length) continue;
      if (b.ice - node.exits > 0) continue;
      if (b.lock && keys) continue;
      const x = s[i * 3], y = s[i * 3 + 1];
      for (const [dx, dy] of DIRS) {
        if (b.axis === 'h' && dy !== 0) continue;
        if (b.axis === 'v' && dx !== 0) continue;
        const nx = x + dx, ny = y + dy;
        let fits = true;
        for (const [cx, cy] of b.cells) {
          const px = nx + cx, py = ny + cy;
          if (px < 0 || py < 0 || px >= w || py >= h) { fits = false; break; }
          const v = occ[py * w + px];
          if (v !== 0 && v !== i + 1) { fits = false; break; }
        }
        if (!fits) continue;
        const next = s.slice();
        next[i * 3] = nx;
        next[i * 3 + 1] = ny;
        let exits = node.exits;
        let st = stage;
        while (st < b.colors.length && exitDoor(i, nx, ny, b.colors[st])) {
          st++;
          exits++;
        }
        next[i * 3 + 2] = st;
        if (st >= b.colors.length) {
          next[i * 3] = 0;
          next[i * 3 + 1] = 0;
        }
        const k = keyOf(next);
        if (seen.has(k)) continue;
        seen.add(k);
        if (++states > maxStates) return { solvable: false, states, complete: false };
        push({ s: next, depth: node.depth + 1, exits, parent: node, step: [i, dx, dy] });
      }
    }
  }
}

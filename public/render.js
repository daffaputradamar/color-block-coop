// Canvas drawing for the board, blocks, doors, effects and teammates' cursors.
import { PALETTE, SIDES, buildOcc, canStep, keysLeft } from '/shared/logic.js';

const FRAME = '#2f3570';
const FRAME_DARK = '#20244f';
const FLOOR = '#161935';
const TILE_A = '#1e2246';
const TILE_B = '#1b1f41';

export function computeLayout(cssW, cssH, level) {
  const cell = Math.max(18, Math.floor(Math.min(cssW / (level.w + 1.2), cssH / (level.h + 1.2), 96)));
  const bw = cell * level.w;
  const bh = cell * level.h;
  return { cell, bw, bh, ox: Math.round((cssW - bw) / 2), oy: Math.round((cssH - bh) / 2), frame: Math.round(cell * 0.24) };
}

// ---------- shape paths ----------

const pathCache = new Map();

// Outline of a polyomino as one rounded, inset polygon: trace the boundary edges of the
// cell union clockwise, push each corner inward by `inset`, then round it with arcTo.
function shapePath(cells, cell, inset, radius) {
  const key = `${cells.join(';')}|${cell}|${inset}|${radius}`;
  let p = pathCache.get(key);
  if (p) return p;
  const has = new Set(cells.map(([x, y]) => `${x},${y}`));
  const H = (x, y) => has.has(`${x},${y}`);
  const edges = new Map();
  const add = (x1, y1, x2, y2) => {
    const k = `${x1},${y1}`;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push([x2, y2]);
  };
  for (const [x, y] of cells) {
    if (!H(x, y - 1)) add(x, y, x + 1, y);
    if (!H(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!H(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!H(x - 1, y)) add(x, y + 1, x, y);
  }
  p = new Path2D();
  while (edges.size) {
    const startKey = edges.keys().next().value;
    let [cx, cy] = startKey.split(',').map(Number);
    const pts = [];
    let prev = null;
    for (let guard = 0; guard < 4096; guard++) {
      const k = `${cx},${cy}`;
      const outs = edges.get(k);
      if (!outs) break;
      // Where two corners touch diagonally, keep turning right to stay on one loop.
      let i = 0;
      if (outs.length > 1 && prev) i = Math.max(0, outs.findIndex(([nx, ny]) => prev[0] * (ny - cy) - prev[1] * (nx - cx) > 0));
      const [nx, ny] = outs.splice(i, 1)[0];
      if (!outs.length) edges.delete(k);
      pts.push([cx, cy]);
      prev = [nx - cx, ny - cy];
      cx = nx;
      cy = ny;
      if (`${cx},${cy}` === startKey) break;
    }
    const n = pts.length;
    const verts = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], v = pts[i], b = pts[(i + 1) % n];
      const d1 = [Math.sign(v[0] - a[0]), Math.sign(v[1] - a[1])];
      const d2 = [Math.sign(b[0] - v[0]), Math.sign(b[1] - v[1])];
      if (d1[0] === d2[0] && d1[1] === d2[1]) continue;
      const convex = d1[0] * d2[1] - d1[1] * d2[0] > 0;
      verts.push({
        x: v[0] * cell + inset * (-d1[1] - d2[1]),
        y: v[1] * cell + inset * (d1[0] + d2[0]),
        r: convex ? radius : radius * 0.5,
      });
    }
    const m = verts.length;
    const mid = (u, w) => [(u.x + w.x) / 2, (u.y + w.y) / 2];
    p.moveTo(...mid(verts[m - 1], verts[0]));
    for (let i = 0; i < m; i++) {
      const v = verts[i];
      const [mx, my] = mid(v, verts[(i + 1) % m]);
      p.arcTo(v.x, v.y, mx, my, v.r);
    }
    p.closePath();
  }
  if (pathCache.size > 600) pathCache.clear();
  pathCache.set(key, p);
  return p;
}

function anchorCell(cells) {
  const cx = cells.reduce((s, c) => s + c[0], 0) / cells.length;
  const cy = cells.reduce((s, c) => s + c[1], 0) / cells.length;
  let best = cells[0];
  let bd = Infinity;
  for (const c of cells) {
    const d = (c[0] - cx) ** 2 + (c[1] - cy) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

function extent(cells) {
  return {
    w: Math.max(...cells.map((c) => c[0])) + 1,
    h: Math.max(...cells.map((c) => c[1])) + 1,
  };
}

// ---------- board ----------

function drawBoard(ctx, level, L) {
  const { cell, ox, oy, bw, bh, frame } = L;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = cell * 0.6;
  ctx.shadowOffsetY = cell * 0.15;
  ctx.fillStyle = FRAME_DARK;
  ctx.beginPath();
  ctx.roundRect(ox - frame, oy - frame + 5, bw + frame * 2, bh + frame * 2, frame * 1.3);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = FRAME;
  ctx.beginPath();
  ctx.roundRect(ox - frame, oy - frame, bw + frame * 2, bh + frame * 2, frame * 1.3);
  ctx.fill();
  ctx.fillStyle = FLOOR;
  ctx.beginPath();
  ctx.roundRect(ox, oy, bw, bh, frame * 0.6);
  ctx.fill();

  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const px = ox + x * cell;
      const py = oy + y * cell;
      if (level.walls[y * level.w + x]) {
        ctx.fillStyle = FRAME;
        ctx.beginPath();
        ctx.roundRect(px - 1, py - 1, cell + 2, cell + 2, cell * 0.12);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.05)';
        ctx.beginPath();
        ctx.roundRect(px + cell * 0.12, py + cell * 0.12, cell * 0.76, cell * 0.76, cell * 0.1);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = (x + y) % 2 ? TILE_A : TILE_B;
      ctx.beginPath();
      ctx.roundRect(px + 2, py + 2, cell - 4, cell - 4, cell * 0.12);
      ctx.fill();
    }
  }
}

function drawDoor(ctx, door, level, L, glow, glyphs, now) {
  const { cell, ox, oy, bw, bh, frame } = L;
  const pal = PALETTE[door.color];
  const horizontal = door.side === 'top' || door.side === 'bottom';
  const len = door.len * cell - cell * 0.16;
  const thick = frame + cell * 0.06;
  let x, y, w, h;
  if (horizontal) {
    x = ox + door.at * cell + cell * 0.08;
    w = len;
    h = thick;
    y = door.side === 'top' ? oy - frame - cell * 0.06 : oy + bh;
  } else {
    y = oy + door.at * cell + cell * 0.08;
    h = len;
    w = thick;
    x = door.side === 'left' ? ox - frame - cell * 0.06 : ox + bw;
  }
  ctx.save();
  if (glow) {
    ctx.shadowColor = pal.base;
    ctx.shadowBlur = cell * (0.35 + 0.15 * Math.sin(now / 150));
  }
  ctx.fillStyle = pal.dark;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.45);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = pal.base;
  ctx.beginPath();
  ctx.roundRect(x + 2, y + 2, w - 4, h - 4, Math.min(w, h) * 0.4);
  ctx.fill();

  // Chevrons pointing out of the board.
  const [sx, sy] = SIDES[door.side];
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.lineWidth = Math.max(1.5, cell * 0.035);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const a = Math.min(w, h) * 0.22;
  const count = door.len;
  for (let i = 0; i < count; i++) {
    const cx = horizontal ? x + (w / count) * (i + 0.5) : x + w / 2;
    const cy = horizontal ? y + h / 2 : y + (h / count) * (i + 0.5);
    ctx.beginPath();
    ctx.moveTo(cx - a * sx - a * sy, cy - a * sy - a * sx);
    ctx.lineTo(cx + a * sx * 0.6, cy + a * sy * 0.6);
    ctx.lineTo(cx - a * sx + a * sy, cy - a * sy + a * sx);
    ctx.stroke();
  }
  if (glyphs) {
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(cell * 0.2)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const gx = horizontal ? x + w / 2 : x + w / 2 + sx * cell * 0.32;
    const gy = horizontal ? y + h / 2 + sy * cell * 0.32 : y + h / 2;
    ctx.fillText(pal.glyph, gx, gy);
  }
  ctx.restore();
}

// ---------- blocks ----------

export function drawBlock(ctx, b, px, py, cell, o = {}) {
  const pal = PALETTE[b.color];
  const g = Math.max(2, cell * 0.055);
  const path = shapePath(b.cells, cell, g, cell * 0.2);
  const depth = Math.max(2, cell * 0.075);
  const lift = o.lift ?? 0;
  const ext = extent(b.cells);

  ctx.save();
  ctx.translate(px, py);
  if (o.alpha != null) ctx.globalAlpha = o.alpha;

  // Shadow on the floor, then the darker side face, then the top face.
  ctx.save();
  ctx.translate(0, depth + lift * 0.4);
  ctx.fillStyle = `rgba(0,0,0,${0.3 + lift / cell})`;
  ctx.fill(path);
  ctx.restore();

  ctx.translate(0, -lift);
  ctx.save();
  ctx.translate(0, depth);
  ctx.fillStyle = pal.dark;
  ctx.fill(path);
  ctx.restore();

  const grad = ctx.createLinearGradient(0, 0, 0, ext.h * cell);
  grad.addColorStop(0, pal.light);
  grad.addColorStop(Math.min(0.5, 0.35 / ext.h), pal.base);
  grad.addColorStop(1, pal.base);
  ctx.fillStyle = grad;
  ctx.fill(path);

  // A layered block shows its next color as a recessed core.
  if (b.layers?.length) {
    const inner = PALETTE[b.layers[0]];
    const ip = shapePath(b.cells, cell, cell * 0.2, cell * 0.14);
    ctx.save();
    ctx.translate(0, -cell * 0.035);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fill(ip);
    ctx.restore();
    ctx.fillStyle = inner.base;
    ctx.fill(ip);
  }

  // Soft stud on each cell.
  for (const [x, y] of b.cells) {
    const cx = x * cell + cell / 2;
    const cy = y * cell + cell / 2;
    ctx.fillStyle = 'rgba(0,0,0,.10)';
    ctx.beginPath();
    ctx.arc(cx, cy + cell * 0.03, cell * 0.21, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath();
    ctx.arc(cx, cy - cell * 0.015, cell * 0.19, 0, Math.PI * 2);
    ctx.fill();
  }

  const [ax, ay] = anchorCell(b.cells);
  const acx = ax * cell + cell / 2;
  const acy = ay * cell + cell / 2;

  if (o.glyphs) {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = `700 ${Math.round(cell * 0.26)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [x, y] of b.cells) ctx.fillText(pal.glyph, x * cell + cell / 2, y * cell + cell / 2 + 1);
    if (b.layers?.length) {
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.font = `700 ${Math.round(cell * 0.16)}px system-ui`;
      ctx.fillText(PALETTE[b.layers[0]].glyph, acx + cell * 0.27, acy + cell * 0.27);
    }
  }

  if (b.axis) {
    const len = (b.axis === 'h' ? ext.w : ext.h) * cell - cell * 0.5;
    const half = Math.max(cell * 0.28, len / 2);
    const mx = (ext.w * cell) / 2;
    const my = (ext.h * cell) / 2;
    const cx = b.axis === 'h' ? mx : acx;
    const cy = b.axis === 'v' ? my : acy;
    const hx = b.axis === 'h' ? 1 : 0;
    const hy = 1 - hx;
    const ah = cell * 0.13;
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = Math.max(2, cell * 0.065);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - hx * half, cy - hy * half);
    ctx.lineTo(cx + hx * half, cy + hy * half);
    for (const s of [-1, 1]) {
      const ex = cx + s * hx * half;
      const ey = cy + s * hy * half;
      ctx.moveTo(ex - s * hx * ah + hy * ah, ey - s * hy * ah + hx * ah);
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex - s * hx * ah - hy * ah, ey - s * hy * ah - hx * ah);
    }
    ctx.stroke();
  }

  if (b.hasKey) emoji(ctx, '🔑', acx, acy, cell * 0.42);
  if (b.lock && o.locked) {
    ctx.fillStyle = 'rgba(15,16,40,.45)';
    ctx.fill(path);
    ctx.strokeStyle = 'rgba(200,205,230,.55)';
    ctx.lineWidth = Math.max(2, cell * 0.05);
    ctx.setLineDash([cell * 0.12, cell * 0.08]);
    ctx.stroke(path);
    ctx.setLineDash([]);
    emoji(ctx, '🔒', acx, acy, cell * 0.45);
  }

  if (b.ice > 0) {
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = 'rgba(205,236,255,.6)';
    ctx.fill(path);
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.lineWidth = Math.max(1.5, cell * 0.035);
    for (const [x, y] of b.cells) {
      const sx = x * cell;
      const sy = y * cell;
      ctx.beginPath();
      ctx.moveTo(sx + cell * 0.18, sy + cell * 0.45);
      ctx.lineTo(sx + cell * 0.45, sy + cell * 0.18);
      ctx.moveTo(sx + cell * 0.55, sy + cell * 0.82);
      ctx.lineTo(sx + cell * 0.82, sy + cell * 0.55);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(160,215,255,.95)';
    ctx.lineWidth = Math.max(2, cell * 0.04);
    ctx.stroke(path);
    ctx.fillStyle = '#1b4f86';
    ctx.font = `700 ${Math.round(cell * 0.46)}px Fredoka, system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(b.ice), acx, acy + 2);
  }

  if (o.outline) {
    ctx.strokeStyle = o.outline;
    ctx.lineWidth = Math.max(2.5, cell * 0.06);
    ctx.stroke(path);
  }

  if (o.badge) {
    const [bx, by] = b.cells.reduce((m, c) => (c[1] < m[1] || (c[1] === m[1] && c[0] < m[0]) ? c : m), b.cells[0]);
    const r = cell * 0.15;
    const cx = bx * cell + g + r * 0.9;
    const cy = by * cell + g + r * 0.9;
    ctx.fillStyle = o.badge.color;
    ctx.strokeStyle = 'rgba(10,12,30,.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#10122a';
    ctx.font = `700 ${Math.round(r * 1.3)}px Fredoka, system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.badge.initial, cx, cy + 1);
  }
  ctx.restore();
}

function emoji(ctx, ch, x, y, size) {
  // Color glyphs still take their opacity from fillStyle, so reset it to opaque.
  ctx.fillStyle = '#000';
  ctx.font = `${Math.round(size)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, x, y + 1);
}

// ---------- cursors / pings ----------

function drawCursor(ctx, x, y, color, name, scale) {
  const s = scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0d0f26';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 18 * s);
  ctx.lineTo(4.5 * s, 14 * s);
  ctx.lineTo(8 * s, 21 * s);
  ctx.lineTo(11 * s, 19.5 * s);
  ctx.lineTo(7.5 * s, 13 * s);
  ctx.lineTo(13 * s, 12.5 * s);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.font = `600 ${Math.round(12 * s)}px Fredoka, system-ui`;
  const tw = ctx.measureText(name).width;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(12 * s, 20 * s, tw + 12 * s, 18 * s, 9 * s);
  ctx.fill();
  ctx.fillStyle = '#10122a';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 18 * s, 29.5 * s);
  ctx.restore();
}

function drawBubble(ctx, x, y, text, alpha, cell) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${Math.round(Math.max(13, cell * 0.24))}px Fredoka, "Segoe UI Emoji", system-ui`;
  const tw = ctx.measureText(text).width;
  const h = Math.max(24, cell * 0.4);
  const bx = x - tw / 2 - 10;
  const by = y - h - 12;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(bx, by, tw + 20, h, h / 2);
  ctx.moveTo(x - 6, by + h - 1);
  ctx.lineTo(x, by + h + 8);
  ctx.lineTo(x + 6, by + h - 1);
  ctx.fill();
  ctx.fillStyle = '#1a1c3a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, by + h / 2 + 1);
  ctx.restore();
}

// ---------- scene ----------

const ease = (t) => 1 - (1 - t) ** 3;

export function drawScene(ctx, S, L, now) {
  const { level } = S;
  const { cell, ox, oy, bw, bh } = L;
  drawBoard(ctx, level, L);

  const held = S.drag ? S.blocks[S.drag.id] : null;
  for (const d of level.doors) {
    const glow = held && !held.gone && held.color === d.color;
    drawDoor(ctx, d, level, L, glow, S.showGlyphs, now);
  }

  const players = new Map(S.players.map((p) => [p.id, p]));
  const locked = keysLeft(S.blocks);
  const occ = held ? buildOcc(level, S.blocks) : null;

  // Draw resting blocks first, then any held ones on top.
  const order = S.blocks.filter((b) => !b.gone).sort((a, b) => (S.grabs[a.id] ? 1 : 0) - (S.grabs[b.id] ? 1 : 0));
  for (const b of order) {
    const d = S.disp.get(b.id) ?? { x: b.x, y: b.y };
    let dx = d.x;
    let dy = d.y;
    // A little give toward the pointer in directions the block can actually go.
    if (held === b && S.drag.target) {
      const fx = Math.max(-0.45, Math.min(0.45, S.drag.target.x - b.x));
      const fy = Math.max(-0.45, Math.min(0.45, S.drag.target.y - b.y));
      if (fx && canStep(level, occ, S.blocks, b, Math.sign(fx), 0)) dx += fx * 0.5;
      if (fy && canStep(level, occ, S.blocks, b, 0, Math.sign(fy))) dy += fy * 0.5;
    }
    const shake = S.shakes.get(b.id);
    if (shake) {
      const t = (now - shake) / 350;
      if (t >= 1) S.shakes.delete(b.id);
      else dx += Math.sin(t * Math.PI * 6) * 0.08 * (1 - t);
    }
    const holder = S.grabs[b.id] ? players.get(S.grabs[b.id]) : null;
    const ownerId = S.owners[b.color];
    const owner = ownerId && ownerId !== S.me ? players.get(ownerId) : null;
    drawBlock(ctx, b, ox + dx * cell, oy + dy * cell, cell, {
      lift: holder ? cell * 0.08 : 0,
      outline: holder ? holder.color : null,
      badge: owner ? { color: owner.color, initial: owner.name[0].toUpperCase() } : null,
      glyphs: S.showGlyphs,
      locked,
    });
  }

  // Exit animations: the block slides into its door and is clipped by the board edge.
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, bw, bh);
  ctx.clip();
  S.effects = S.effects.filter((e) => now - e.t0 < e.dur);
  for (const e of S.effects) {
    if (e.kind !== 'exit') continue;
    const t = ease((now - e.t0) / e.dur);
    const dist = (e.dir[0] ? e.ext.w : e.ext.h) + 0.3;
    drawBlock(ctx, e.block, ox + (e.x + e.dir[0] * dist * t) * cell, oy + (e.y + e.dir[1] * dist * t) * cell, cell, { glyphs: S.showGlyphs });
  }
  ctx.restore();

  for (const e of S.effects) {
    if (e.kind !== 'particles') continue;
    const t = (now - e.t0) / 1000;
    for (const p of e.parts) {
      const life = 1 - (now - e.t0) / e.dur;
      ctx.globalAlpha = Math.max(0, life);
      ctx.fillStyle = p.c;
      const px = ox + e.x * cell + p.vx * t * cell;
      const py = oy + e.y * cell + p.vy * t * cell + 3 * t * t * cell;
      ctx.beginPath();
      ctx.roundRect(px - p.s / 2, py - p.s / 2, p.s, p.s, p.s * 0.3);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Pings.
  S.pings = S.pings.filter((p) => now - p.t0 < 1600);
  for (const p of S.pings) {
    const t = (now - p.t0) / 1600;
    const cx = ox + (Math.floor(p.x) + 0.5) * cell;
    const cy = oy + (Math.floor(p.y) + 0.5) * cell;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = 1 - t;
    for (const k of [0, 0.3]) {
      const tt = Math.max(0, t - k);
      ctx.lineWidth = 4 * (1 - tt);
      ctx.beginPath();
      ctx.arc(cx, cy, cell * (0.2 + tt * 0.9), 0, Math.PI * 2);
      ctx.stroke();
    }
    const bob = Math.sin(t * Math.PI * 4) * cell * 0.06;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - cell * 0.12 + bob);
    ctx.lineTo(cx - cell * 0.14, cy - cell * 0.4 + bob);
    ctx.lineTo(cx + cell * 0.14, cy - cell * 0.4 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Teammates' cursors and emote bubbles.
  const scale = Math.max(0.8, Math.min(1.2, cell / 64));
  for (const [pid, c] of S.cursors) {
    const p = players.get(pid);
    if (!p || now - c.t > 5000) continue;
    const d = c.disp ?? (c.disp = { x: c.x, y: c.y });
    d.x += (c.x - d.x) * 0.35;
    d.y += (c.y - d.y) * 0.35;
    drawCursor(ctx, ox + d.x * cell, oy + d.y * cell, p.color, p.name, scale);
  }
  S.bubbles = S.bubbles.filter((b) => now - b.t0 < 2200);
  for (const b of S.bubbles) {
    const c = b.pid === S.me ? S.myCursor : S.cursors.get(b.pid)?.disp;
    if (!c) continue;
    const t = (now - b.t0) / 2200;
    drawBubble(ctx, ox + c.x * cell, oy + c.y * cell, b.text, t > 0.8 ? (1 - t) * 5 : 1, cell);
  }
}

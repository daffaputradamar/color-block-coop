// Color Block Co-op server: serves the web client and runs authoritative game rooms over WebSocket.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WebSocketServer } from 'ws';
import { LEVELS } from './shared/levels.js';
import {
  EMOTES, parseLevel, buildOcc, canStep, moveStep, resolveExits, moveBlocker,
  isWon, levelColors, assignColors,
} from './shared/logic.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 4;
const UNLOCK_ALL = process.env.UNLOCK_ALL === '1';
const PLAYER_COLORS = ['#ff5fa2', '#3ddcff', '#b6f24a', '#ffb13d'];
const MAX_ENDLESS_RESUME = 200;

const MAX_WORKERS = 2;

// Browser origins allowed to open game sockets when the frontend is hosted elsewhere, e.g.
// ALLOWED_ORIGINS="https://color-block.vercel.app,https://color-block-*-myteam.vercel.app".
// A '*' wildcard on vercel.app is a convenience for previews, not an access boundary: anyone can
// claim a vercel.app name that happens to match. List exact URLs for anything that matters.
// Unset allows any origin. This server's own pages and non-browser clients (no Origin) always pass.
const ORIGIN_ENTRIES = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)
  .map((s) => (s.includes('://') ? s : `https://${s}`));
const ALLOWED_ORIGINS = ORIGIN_ENTRIES.map((p) => {
  // '*' matches one DNS label fragment, enough for Vercel preview URLs.
  const pattern = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*');
  return new RegExp('^' + pattern + '$', 'i');
});
for (const entry of ORIGIN_ENTRIES) {
  if (/^[a-z]+:\/\/[^/?#]+$/i.test(entry)) continue;
  console.warn(`ALLOWED_ORIGINS entry "${entry}" can never match a browser origin (scheme://host[:port] only).`);
}

function originAllowed(origin, host) {
  if (!ALLOWED_ORIGINS.length || !origin) return true;
  try {
    if (new URL(origin).host === host) return true;
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.some((re) => re.test(origin));
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// ---------- static files ----------

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error('HTTP handler failed:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function handleHttp(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/healthz') {
    // Hosting health checks, and the Vercel frontend waking a sleeping free instance. Browsers
    // send Origin on this cross-origin fetch, so the page also learns whether sockets would be refused.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(originAllowed(req.headers.origin, req.headers.host) ? 'ok' : 'origin-refused');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const shared = pathname.startsWith('/shared/');
  const base = join(ROOT, shared ? 'shared' : 'public');
  const file = normalize(join(base, shared ? pathname.slice('/shared'.length) : pathname));
  if (!file.startsWith(base + sep) || pathname.includes('\0')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// ---------- endless levels ----------

// Generation runs in worker threads, at most MAX_WORKERS at once across all rooms. A job can be
// cancelled (queued or running) when its room moves on before it finishes.
let activeWorkers = 0;
const workerQueue = [];

function generateAsync(stage, seed) {
  const job = { cancelled: false, worker: null };
  job.promise = new Promise((resolve) => {
    job.run = () => {
      if (job.cancelled) return resolve(null);
      activeWorkers++;
      const worker = new Worker(new URL('./shared/gen-worker.js', import.meta.url), { workerData: { stage, seed } });
      job.worker = worker;
      let settled = false;
      const finish = (def) => {
        if (settled) return;
        settled = true;
        activeWorkers--;
        resolve(def);
        pumpWorkers();
      };
      worker.once('message', finish);
      worker.once('error', () => finish(null));
      worker.once('exit', () => finish(null));
    };
  });
  job.cancel = () => {
    job.cancelled = true;
    job.worker?.terminate();
  };
  workerQueue.push(job);
  pumpWorkers();
  return job;
}

function pumpWorkers() {
  while (activeWorkers < MAX_WORKERS && workerQueue.length) workerQueue.shift().run();
}

// ---------- rooms ----------

const rooms = new Map();
let nextPlayerId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  // `resume` rebuilds progress for players reconnecting after a server restart wiped their room.
  constructor(code, resume = null) {
    this.code = code;
    this.players = new Map();
    this.mode = 'split';
    this.levelIndex = 0;
    this.unlocked = UNLOCK_ALL ? LEVELS.length : 0;
    this.seed = Math.floor(Math.random() * 1e9);
    this.loadToken = 0;
    this.grabs = new Map();
    this.status = 'loading';
    this.emptySince = null;
    // Empty board until the first level loads (an endless level loads asynchronously).
    this.level = null;
    this.blocks = [];
    this.owners = {};
    let start = 0;
    const unlocked = resume?.unlocked;
    const index = resume?.levelIndex;
    if (Number.isInteger(unlocked) && unlocked >= 0) this.unlocked = Math.max(this.unlocked, Math.min(unlocked, LEVELS.length + MAX_ENDLESS_RESUME));
    if (Number.isInteger(index) && index >= 0) start = Math.min(index, this.unlocked);
    this.load(start);
  }

  send(player, msg) {
    if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except = null) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(data);
  }

  async load(index) {
    const token = ++this.loadToken;
    this.genJob?.cancel();
    this.genJob = null;
    clearTimeout(this.timer);
    this.status = 'loading';
    this.loadingIndex = index;
    this.grabs.clear();
    this.broadcast({ type: 'loading', levelIndex: index });
    let def = LEVELS[index];
    if (!def) {
      this.genJob = generateAsync(index - LEVELS.length, this.seed + index);
      def = await this.genJob.promise;
    }
    if (token !== this.loadToken) return;
    this.genJob = null;
    this.def = def ?? LEVELS[LEVELS.length - 1];
    this.levelIndex = index;
    this.reset();
  }

  reset() {
    clearTimeout(this.timer);
    const { level, blocks } = parseLevel(this.def, this.levelIndex);
    this.level = level;
    this.blocks = blocks;
    this.status = 'ready';
    this.endsAt = null;
    this.result = null;
    this.exitsBy = {};
    this.grabs.clear();
    this.reassign();
    this.sendState();
  }

  // Called on reset, join/leave and mode change, never on exits, so ownership stays put during play.
  reassign() {
    const colors = levelColors(this.blocks);
    this.owners = this.mode === 'split' ? assignColors(colors, [...this.players.keys()]) : {};
    for (const [id, pid] of this.grabs) {
      const owner = this.owners[this.blocks[id].color];
      if (owner && owner !== pid) this.grabs.delete(id);
    }
  }

  sendState(events = []) {
    if (this.status === 'loading') return;
    this.broadcast({
      type: 'state',
      code: this.code,
      level: this.level,
      blocks: this.blocks,
      status: this.status,
      endsAt: this.endsAt,
      now: Date.now(),
      mode: this.mode,
      owners: this.owners,
      players: [...this.players.values()].map(({ id, name, color }) => ({ id, name, color })),
      grabs: Object.fromEntries(this.grabs),
      levelIndex: this.levelIndex,
      unlocked: this.unlocked,
      campaign: LEVELS.length,
      campaignNames: LEVELS.map((l) => l.name),
      result: this.result,
      events,
    });
  }

  start() {
    this.status = 'playing';
    this.endsAt = Date.now() + this.level.time * 1000;
    this.timer = setTimeout(() => this.lose(), this.level.time * 1000);
  }

  lose() {
    if (this.status !== 'playing') return;
    this.status = 'lost';
    this.grabs.clear();
    this.result = { exitsBy: this.exitsBy };
    this.sendState();
  }

  afterExits(events, pid) {
    for (const e of events) {
      this.grabs.delete(e.id);
      this.exitsBy[pid] = (this.exitsBy[pid] ?? 0) + 1;
    }
    if (isWon(this.blocks)) {
      clearTimeout(this.timer);
      const timeLeft = Math.max(0, this.endsAt - Date.now());
      const frac = timeLeft / (this.level.time * 1000);
      this.status = 'won';
      this.unlocked = Math.max(this.unlocked, this.levelIndex + 1);
      this.result = { timeLeft, stars: frac > 0.5 ? 3 : frac > 0.2 ? 2 : 1, exitsBy: this.exitsBy };
    }
    this.sendState(events);
  }

  // ----- player actions -----

  join(player) {
    this.players.set(player.id, player);
    this.emptySince = null;
    this.reassign();
    this.welcome(player);
  }

  // The same browser tab reconnected before its old socket timed out (e.g. a phone switching
  // networks): hand it the old seat so it keeps its id, color and owned colors.
  replace(old, player) {
    this.players.set(old.id, player);
    for (const [id, pid] of this.grabs) if (pid === old.id) this.grabs.delete(id);
    old.ws.terminate();
    this.welcome(player);
  }

  welcome(player) {
    this.send(player, { type: 'welcome', you: player.id, code: this.code });
    if (this.status === 'loading') this.send(player, { type: 'loading', levelIndex: this.loadingIndex });
    else this.sendState();
  }

  leave(player) {
    // A socket replaced by a reconnect of the same tab closes late; its seat is already taken over.
    if (this.players.get(player.id) !== player) return;
    this.players.delete(player.id);
    for (const [id, pid] of this.grabs) if (pid === player.id) this.grabs.delete(id);
    if (!this.players.size) {
      this.emptySince = Date.now();
      return;
    }
    this.reassign();
    this.sendState();
  }

  deny(player, id, reason) {
    const b = this.blocks[id];
    const extra = {};
    if (reason === 'owner') extra.owner = this.owners[b.color];
    if (reason === 'held') extra.owner = this.grabs.get(id);
    if (reason === 'ice') extra.ice = b.ice;
    this.send(player, { type: 'deny', id, reason, ...extra });
  }

  onGrab(player, { id }) {
    if (this.status !== 'ready' && this.status !== 'playing') return;
    const b = this.blocks[id];
    if (!b || b.gone) return;
    const blocked = moveBlocker(this.blocks, b);
    if (blocked) return this.deny(player, id, blocked);
    const holder = this.grabs.get(id);
    if (holder && holder !== player.id) return this.deny(player, id, 'held');
    const owner = this.owners[b.color];
    if (owner && owner !== player.id) return this.deny(player, id, 'owner');
    for (const [bid, pid] of this.grabs) {
      if (pid === player.id && bid !== id) {
        this.grabs.delete(bid);
        this.broadcast({ type: 'release', id: bid });
      }
    }
    this.grabs.set(id, player.id);
    if (this.status === 'ready') {
      this.start();
      this.sendState();
    } else {
      this.broadcast({ type: 'grab', id, by: player.id });
    }
    // Tapping a block that already lines up with its door sends it through.
    const events = resolveExits(this.level, buildOcc(this.level, this.blocks), this.blocks, b);
    if (events.length) this.afterExits(events, player.id);
  }

  onMove(player, { id, steps }) {
    if (this.status !== 'playing' || !Array.isArray(steps)) return;
    const b = this.blocks[id];
    if (!b || b.gone || this.grabs.get(id) !== player.id) {
      if (b && !b.gone) this.send(player, { type: 'moved', id, x: b.x, y: b.y, by: null });
      return;
    }
    const occ = buildOcc(this.level, this.blocks);
    let rejected = false;
    let events = [];
    for (const step of steps.slice(0, 40)) {
      const [dx, dy] = Array.isArray(step) ? step : [];
      if (!Number.isInteger(dx) || !Number.isInteger(dy) || !canStep(this.level, occ, this.blocks, b, dx, dy)) {
        rejected = true;
        break;
      }
      moveStep(occ, this.level, b, dx, dy);
      events = resolveExits(this.level, occ, this.blocks, b);
      if (events.length) break;
    }
    // A rejected batch has by: null so the mover snaps back to the server's position.
    this.broadcast({ type: 'moved', id, x: b.x, y: b.y, by: rejected ? null : player.id });
    if (events.length) this.afterExits(events, player.id);
  }

  onRelease(player, { id }) {
    if (this.grabs.get(id) !== player.id) return;
    this.grabs.delete(id);
    this.broadcast({ type: 'release', id });
  }

  onCursor(player, { x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.broadcast({ type: 'cursor', pid: player.id, x: +x.toFixed(2), y: +y.toFixed(2) }, player);
  }

  onPing(player, { x, y }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.broadcast({ type: 'ping', pid: player.id, x, y });
  }

  onEmote(player, { i }) {
    if (Number.isInteger(i) && EMOTES[i]) this.broadcast({ type: 'emote', pid: player.id, i });
  }

  onRetry(player) {
    if (this.status === 'loading') return;
    this.reset();
    this.broadcast({ type: 'notice', text: `${player.name} restarted the level` });
  }

  onNext() {
    if (this.status === 'won') this.load(this.levelIndex + 1);
  }

  onLevel(player, { index }) {
    // Ignored while a level is generating, so spamming level picks can't pile up work.
    if (this.status === 'loading') return;
    if (Number.isInteger(index) && index >= 0 && index <= this.unlocked) this.load(index);
  }

  onMode(player, { mode }) {
    if (mode !== 'split' && mode !== 'free') return;
    this.mode = mode;
    this.reassign();
    this.sendState();
    this.broadcast({ type: 'notice', text: `${player.name} switched to ${mode === 'split' ? 'Split colors' : 'Shared hands'}` });
  }
}

// ---------- sockets ----------

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024,
  verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host),
});

const HANDLERS = {
  grab: 'onGrab', move: 'onMove', release: 'onRelease', cursor: 'onCursor', ping: 'onPing',
  emote: 'onEmote', retry: 'onRetry', next: 'onNext', level: 'onLevel', mode: 'onMode',
};

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let player = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    try {
      if (msg.type === 'join' && !player) {
        const wanted = String(msg.room ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
        if (msg.room && wanted.length < 4) {
          ws.send(JSON.stringify({ type: 'error', text: 'Room codes are 4 letters.' }));
          return;
        }
        const code = wanted || makeCode();
        room = rooms.get(code);
        if (!room) {
          room = new Room(code, wanted && msg.resume && typeof msg.resume === 'object' ? msg.resume : null);
          rooms.set(code, room);
        }
        // A per-tab session token lets a reconnecting tab reclaim its seat from a stale socket.
        const session = typeof msg.session === 'string' && msg.session ? msg.session.slice(0, 64) : null;
        const ghost = session ? [...room.players.values()].find((p) => p.session === session) : null;
        if (!ghost && room.players.size >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: 'error', text: `Room ${code} is full (${MAX_PLAYERS} players max).` }));
          room = null;
          return;
        }
        const used = new Set([...room.players.values()].filter((p) => p !== ghost).map((p) => p.color));
        const name = String(msg.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
        player = {
          id: ghost?.id ?? `p${nextPlayerId++}`,
          name,
          color: ghost?.color ?? PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0],
          session,
          ws,
        };
        if (ghost) room.replace(ghost, player);
        else room.join(player);
        return;
      }

      const handler = room && Object.hasOwn(HANDLERS, msg.type) ? HANDLERS[msg.type] : null;
      if (handler) room[handler](player, msg);
    } catch (err) {
      // One bad message must never take the whole server (and every room) down.
      console.error('Message handler failed:', err);
    }
  });

  ws.on('close', () => {
    if (room && player) room.leave(player);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > 10 * 60 * 1000) {
      clearTimeout(room.timer);
      room.genJob?.cancel();
      rooms.delete(code);
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Color Block Co-op running at http://localhost:${PORT}`);
  console.log(ORIGIN_ENTRIES.length ? `Allowed origins: ${ORIGIN_ENTRIES.join(', ')}` : 'Allowed origins: any');
});

// On a deploy the host keeps this old instance alive next to the new one, then sends SIGTERM.
// Closing sockets right away sends players to the new instance, where their room is rebuilt
// from the progress the client resends on rejoin.
function shutdown() {
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  server.close();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

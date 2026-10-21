// End-to-end check: two players join a seeded room and clear its first (generated) level by
// replaying the solver's solution, plus seeds, deployment hooks and review regressions.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildOcc, canPlace, cloneBlocks, isWon, moveStep, resolveExits } from '../shared/logic.js';
import { solve } from '../shared/solver.js';

const PORT = 3999;
const root = fileURLToPath(new URL('..', import.meta.url));
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), UNLOCK_ALL: '', ALLOWED_ORIGINS: 'https://good.example, https://cb-*.vercel.app, bare.example' },
});
await new Promise((resolve) => server.stdout.once('data', resolve));
let serverExited = false;
server.on('exit', (code, signal) => {
  serverExited = true;
  if (!finished) console.log(`server exited early (code ${code}, signal ${signal})`);
});
let finished = false;
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

// Sends raw bytes over TCP and resolves the first response line (or '' if the socket dies).
function rawHttp(request) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, 'localhost', () => sock.write(request));
    let data = '';
    sock.on('data', (d) => {
      data += d;
      if (data.includes('\r\n')) {
        sock.destroy();
        resolve(data.split('\r\n')[0]);
      }
    });
    sock.on('error', () => resolve(''));
    sock.on('close', () => resolve(data.split('\r\n')[0]));
  });
}

async function health(origin) {
  const res = await fetch(`http://localhost:${PORT}/healthz`, origin ? { headers: { Origin: origin } } : {});
  return res.text();
}

// Resolves 'open' or 'rejected' for a socket presenting the given browser Origin.
function tryOrigin(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, origin ? { origin } : {});
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('error', () => resolve('rejected'));
  });
}

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  ws.on('error', () => {});
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  return {
    ws,
    name,
    send: (m) => ws.send(JSON.stringify(m)),
    wait(pred, label) {
      const hit = inbox.find(pred);
      if (hit) {
        inbox.splice(inbox.indexOf(hit), 1);
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name}: timed out waiting for ${label}`)), 3000);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), inbox.splice(inbox.indexOf(m), 1), resolve(m)) });
      });
    },
    open: () => new Promise((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.once('open', r))),
  };
}

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

// Plays a level to the win through the real protocol. Each block is always moved by the same
// player, every step waits for the server's ack, and the local mirror follows the same rules.
async function playOut(state, players) {
  const { level } = state;
  const blocks = cloneBlocks(state.blocks);
  for (let round = 0; round < 50 && !isWon(blocks); round++) {
    const res = solve(level, blocks, { maxStates: 300000 });
    if (!res.solvable) throw new Error('solver found no solution for the current board');
    for (const [id, dx, dy] of res.path) {
      const p = players[id % players.length];
      const b = blocks[id];
      if (p.held !== id) {
        p.send({ type: 'grab', id });
        p.held = id;
        // Grabbing a block that already lines up with its door sends it through: re-plan.
        const events = resolveExits(level, buildOcc(level, blocks), blocks, b);
        if (events.length) {
          await p.wait((m) => m.type === 'state' && m.events?.some((e) => e.id === id), 'grab exit');
          p.held = null;
          break;
        }
      }
      p.send({ type: 'move', id, steps: [[dx, dy]] });
      const mv = await p.wait((m) => m.type === 'moved' && m.id === id, 'move ack');
      if (mv.by === null) throw new Error('server rejected a solver step');
      const occ = buildOcc(level, blocks);
      moveStep(occ, level, b, dx, dy);
      if (resolveExits(level, occ, blocks, b).length) {
        await p.wait((m) => m.type === 'state' && m.events?.some((e) => e.id === id), 'exit');
        if (b.gone) p.held = null;
      }
    }
  }
}

// A block and a direction where the target cells are on the board but another block is in the way.
function blockedStep(level, blocks) {
  const occ = buildOcc(level, blocks);
  for (const b of blocks) {
    if (b.ice || b.lock) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if ((b.axis === 'h' && dy) || (b.axis === 'v' && dx)) continue;
      const cells = b.cells.map(([cx, cy]) => [b.x + cx + dx, b.y + cy + dy]);
      const onBoard = cells.every(([x, y]) => x >= 0 && y >= 0 && x < level.w && y < level.h && !level.walls[y * level.w + x]);
      if (onBoard && !canPlace(level, occ, b, b.x + dx, b.y + dy)) return { b, dx, dy };
    }
  }
  return null;
}

async function firstState(name, join) {
  const c = client(name);
  await c.open();
  c.send({ type: 'join', name, ...join });
  c.you = (await c.wait((m) => m.type === 'welcome', 'welcome')).you;
  return { c, st: await c.wait((m) => m.type === 'state', 'state') };
}
const boardKey = (st) => JSON.stringify([st.level.walls, st.level.doors, st.blocks.map((b) => [b.x, b.y, b.cells, b.color, b.layers])]);

try {
  const a = client('Alice');
  await a.open();
  a.send({ type: 'join', name: 'Alice', seed: 'smoke-1' });
  const wa = await a.wait((m) => m.type === 'welcome', 'welcome');
  a.you = wa.you;
  check(/^[A-Z]{4}$/.test(wa.code), `room created (${wa.code})`);
  const first = await a.wait((m) => m.type === 'state', 'first state');
  check(first.seed === 'SMOKE1', 'room uses the chosen seed, normalized to letters and digits');

  const b = client('Bob');
  await b.open();
  b.send({ type: 'join', name: 'Bob', room: wa.code, seed: 'OTHER' });
  const wb = await b.wait((m) => m.type === 'welcome', 'welcome');
  b.you = wb.you;
  check(wb.code === wa.code, 'second player joined the same room');
  const st = await a.wait((m) => m.type === 'state' && m.players.length === 2, 'two-player state');
  check(st.seed === 'SMOKE1', "joining keeps the room's seed");
  const owners = Object.values(st.owners);
  check(owners.length > 0 && owners.every((o) => o === a.you || o === b.you) && new Set(owners).size === Math.min(2, owners.length),
    'colors split between players');

  const bobs = st.blocks.find((x) => st.owners[x.color] === b.you && !x.ice && !x.lock);
  if (bobs) {
    a.send({ type: 'grab', id: bobs.id });
    const deny = await a.wait((m) => m.type === 'deny', 'deny');
    check(deny.reason === 'owner' && deny.owner === b.you, "Alice can't grab Bob's block");
  }

  a.send({ type: 'mode', mode: 'free' });
  const free = await b.wait((m) => m.type === 'state' && m.mode === 'free', 'shared hands');
  const blocked = blockedStep(free.level, free.blocks);
  if (blocked) {
    a.send({ type: 'grab', id: blocked.b.id });
    a.send({ type: 'move', id: blocked.b.id, steps: [[blocked.dx, blocked.dy]] });
    const mv = await a.wait((m) => m.type === 'moved' && m.id === blocked.b.id, 'blocked move');
    check(mv.by === null && mv.x === blocked.b.x && mv.y === blocked.b.y, 'a move into another block is rejected and the mover corrected');
    a.send({ type: 'release', id: blocked.b.id });
  }

  await playOut(free, [a, b]);
  const won = await b.wait((m) => m.type === 'state' && m.status === 'won', 'win');
  const exitsNeeded = free.blocks.reduce((n, x) => n + 1 + x.layers.length, 0);
  check(won.unlocked === 1 && won.result.stars >= 2, 'generated level cleared by replaying the solver, level 2 unlocked');
  check(Object.values(won.result.exitsBy).reduce((x, y) => x + y, 0) === exitsNeeded, 'per-player exit stats add up');

  b.send({ type: 'next' });
  const next = await a.wait((m) => m.type === 'state' && m.levelIndex === 1, 'level 2');
  check(next.status === 'ready' && next.seed === 'SMOKE1', 'anyone can advance to the next level');

  a.send({ type: 'level', index: 5 });
  const locked = await Promise.race([
    a.wait((m) => m.type === 'loading' && m.levelIndex === 5, 'loading').then(() => 'loaded'),
    new Promise((r) => setTimeout(() => r('ignored'), 400)),
  ]);
  check(locked === 'ignored', 'locked levels cannot be selected');

  // ----- seeds -----
  const same1 = await firstState('S1', { seed: 'same' });
  const same2 = await firstState('S2', { seed: 'SAME' });
  const other = await firstState('S3', { seed: 'different' });
  const random = await firstState('S4', {});
  check(boardKey(same1.st) === boardKey(same2.st), 'the same seed gives the same board');
  check(boardKey(same1.st) !== boardKey(other.st), 'a different seed gives a different board');
  check(/^[A-Z2-9]{6}$/.test(random.st.seed), `a room without a seed gets a random one (${random.st.seed})`);
  const re1 = await firstState('S5', { room: 'QQSA', resume: { levelIndex: 2, unlocked: 2, seed: 'SAME' } });
  const re2 = await firstState('S6', { room: 'QQSB', resume: { levelIndex: 2, unlocked: 2, seed: 'SAME' } });
  check(re1.st.seed === 'SAME' && re1.st.levelIndex === 2 && boardKey(re1.st) === boardKey(re2.st), 'a rebuilt room keeps its seed and boards');
  for (const x of [same1, same2, other, random, re1, re2]) x.c.ws.close();

  a.ws.close();
  b.ws.close();

  // ----- deployment hooks -----
  const hz = await fetch(`http://localhost:${PORT}/healthz`);
  check(hz.status === 200 && (await hz.text()) === 'ok' && hz.headers.get('access-control-allow-origin') === '*', '/healthz answers ok with CORS');

  check((await tryOrigin('https://good.example')) === 'open', 'allowed origin can connect');
  check((await tryOrigin('https://cb-git-main-team.vercel.app')) === 'open', 'wildcard preview origin can connect');
  check((await tryOrigin('https://evil.example')) === 'rejected', 'unknown origin is rejected');
  check((await tryOrigin('https://cb-x.vercel.app.evil.example')) === 'rejected', 'lookalike origin is rejected');
  check((await tryOrigin(`http://localhost:${PORT}`)) === 'open', "the server's own page origin can connect");
  check((await tryOrigin(null)) === 'open', 'non-browser client without Origin can connect');

  const c = client('Cara');
  await c.open();
  c.send({ type: 'join', name: 'Cara', room: 'QQZZ', resume: { levelIndex: 2, unlocked: 3 } });
  const resumed = await c.wait((m) => m.type === 'state', 'resumed state');
  check(resumed.levelIndex === 2 && resumed.unlocked === 3, 'rejoining a wiped room restores its level and unlocks');

  const d = client('Dan');
  await d.open();
  d.send({ type: 'join', name: 'Dan', room: 'QQZZ', resume: { levelIndex: 8, unlocked: 9 } });
  const joined = await d.wait((m) => m.type === 'state', 'joined state');
  check(joined.levelIndex === 2 && joined.unlocked === 3, 'resume is ignored when the room already exists');

  const e = client('Eve');
  await e.open();
  e.send({ type: 'join', name: 'Eve', room: 'QQWW', resume: { levelIndex: 1, unlocked: 1e9 } });
  const clamped = await e.wait((m) => m.type === 'state', 'clamped state');
  check(clamped.levelIndex === 1 && clamped.unlocked === 500, 'resume values are clamped');

  const f = client('Fay');
  await f.open();
  f.send({ type: 'join', name: 'Fay', resume: { levelIndex: 5, unlocked: 5 } });
  const fresh = await f.wait((m) => m.type === 'state', 'new room state');
  check(fresh.levelIndex === 0 && fresh.unlocked === 0, 'a brand-new room ignores resume');

  for (const x of [c, d, e, f]) x.ws.close();

  // ----- regressions from review -----
  check((await health('https://evil.example')) === 'origin-refused', '/healthz tells a refused origin why');
  check((await health('https://good.example')) === 'ok', '/healthz says ok to an allowed origin');
  check((await tryOrigin('https://bare.example')) === 'open', 'ALLOWED_ORIGINS entry without a scheme gets https://');

  const g = client('Gus');
  await g.open();
  g.send({ type: 'join', name: 'Gus', room: 'QQEE', resume: { levelIndex: 3, unlocked: 3 } });
  const genNotice = await g.wait((m) => m.type === 'loading' || m.type === 'state', 'loading notice');
  check(genNotice.type === 'loading', 'joining a room that is still generating gets a loading notice');
  const later = await g.wait((m) => m.type === 'state', 'rebuilt room');
  check(later.levelIndex === 3 && later.status === 'ready', 'rebuilding a room at a later level works');

  g.send({ type: 'level', index: 3 });
  g.send({ type: 'level', index: 2 });
  g.send({ type: 'level', index: 1 });
  await g.wait((m) => m.type === 'loading', 'reload');
  const settled = await g.wait((m) => m.type === 'state', 'reload settled');
  const extraLoad = await Promise.race([
    g.wait((m) => m.type === 'loading', 'extra load').then(() => true),
    new Promise((r) => setTimeout(() => r(false), 400)),
  ]);
  check(settled.levelIndex === 3 && !extraLoad, 'level picks are ignored while a level is generating');

  for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) g.send({ type });
  check((await rawHttp('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n')).startsWith('HTTP/1.1 400'), 'malformed request path answers 400');
  await new Promise((r) => setTimeout(r, 200));
  check(!serverExited && (await health()) === 'ok', 'server survives prototype-named messages and bad paths');
  g.ws.close();

  const shortCode = client('Hal');
  await shortCode.open();
  shortCode.send({ type: 'join', name: 'Hal', room: 'AB' });
  const shortErr = await shortCode.wait((m) => m.type === 'error' || m.type === 'welcome', 'short code reply');
  check(shortErr.type === 'error' && /4 letters/.test(shortErr.text), 'a cut-off room code is refused instead of creating a room');
  shortCode.ws.close();

  // Four seats taken; one tab's socket goes stale and it reconnects with the same session.
  const seats = ['S1', 'S2', 'S3', 'S4'].map((n) => client(n));
  for (const [i, s] of seats.entries()) {
    await s.open();
    s.send({ type: 'join', name: s.name, room: 'QQRR', session: `tab-${i}` });
    await s.wait((m) => m.type === 'welcome', 'seat welcome');
  }
  const oldId = (await seats[3].wait((m) => m.type === 'state', 'seat state')).players.find((p) => p.name === 'S4').id;
  const rejoin = client('S4');
  await rejoin.open();
  const oldClosed = new Promise((r) => seats[3].ws.once('close', () => r(true)));
  rejoin.send({ type: 'join', name: 'S4', room: 'QQRR', session: 'tab-3' });
  const back = await rejoin.wait((m) => m.type === 'welcome' || m.type === 'error', 'rejoin reply');
  const backState = back.type === 'welcome' ? await rejoin.wait((m) => m.type === 'state', 'rejoin state') : null;
  check(back.type === 'welcome' && back.you === oldId, 'a reconnecting tab gets its seat back in a full room');
  check(backState?.players.length === 4 && (await oldClosed), 'the stale socket is dropped, not counted twice');
  const outsider = client('S5');
  await outsider.open();
  outsider.send({ type: 'join', name: 'S5', room: 'QQRR', session: 'tab-other' });
  check((await outsider.wait((m) => m.type === 'error' || m.type === 'welcome', 'outsider reply')).type === 'error', 'a different tab still sees the room as full');
  for (const s of [...seats, rejoin, outsider]) s.ws.close();
} catch (e) {
  console.log('FAIL ', e.message);
  failures++;
} finally {
  finished = true;
  server.kill();
}
process.exit(failures ? 1 : 0);

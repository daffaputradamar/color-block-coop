// End-to-end check: two players join one room and clear level 1 in split-colors mode,
// plus the deployment hooks (health check, origin allowlist, room rebuild after restart).
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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

try {
  const a = client('Alice');
  await a.open();
  a.send({ type: 'join', name: 'Alice' });
  const wa = await a.wait((m) => m.type === 'welcome', 'welcome');
  check(/^[A-Z]{4}$/.test(wa.code), `room created (${wa.code})`);
  await a.wait((m) => m.type === 'state', 'first state');

  const b = client('Bob');
  await b.open();
  b.send({ type: 'join', name: 'Bob', room: wa.code });
  const wb = await b.wait((m) => m.type === 'welcome', 'welcome');
  check(wb.code === wa.code, 'second player joined the same room');
  const st = await a.wait((m) => m.type === 'state' && m.players.length === 2, 'two-player state');
  check(st.owners.red === wa.you && st.owners.blue === wb.you && st.owners.green === wa.you, 'colors split between players');

  const id = (tag) => st.blocks.find((x) => x.tag === tag).id;

  a.send({ type: 'grab', id: id('B') });
  const deny = await a.wait((m) => m.type === 'deny', 'deny');
  check(deny.reason === 'owner' && deny.owner === wb.you, "Alice can't grab Bob's blue block");

  b.send({ type: 'grab', id: id('B') });
  await b.wait((m) => m.type === 'state' && m.status === 'playing', 'timer start');
  b.send({ type: 'move', id: id('B'), steps: [[-1, 0], [-1, 0]] });
  const exitB = await a.wait((m) => m.type === 'state' && m.events?.length, 'blue exit');
  check(exitB.events[0].id === id('B') && exitB.blocks[id('B')].gone, 'blue block left through the blue door');

  a.send({ type: 'grab', id: id('R') });
  await a.wait((m) => m.type === 'grab', 'grab red');
  a.send({ type: 'move', id: id('R'), steps: [[1, 0], [1, 0]] });
  const moved = await a.wait((m) => m.type === 'moved' && m.id === id('R'), 'red moved');
  check(moved.by === null && moved.x === 1, 'move into the green block stops at x=1 and the mover is corrected');
  a.send({ type: 'release', id: id('R') });

  a.send({ type: 'grab', id: id('G') });
  a.send({ type: 'move', id: id('G'), steps: [[0, 1], [0, 1]] });
  await a.wait((m) => m.type === 'state' && m.events?.some((e) => e.id === id('G')), 'green exit');

  a.send({ type: 'grab', id: id('R') });
  a.send({ type: 'move', id: id('R'), steps: [[1, 0]] });
  const won = await b.wait((m) => m.type === 'state' && m.status === 'won', 'win');
  check(won.result.stars === 3 && won.unlocked === 1, 'level cleared with 3 stars, level 2 unlocked');
  check(won.result.exitsBy[wa.you] === 2 && won.result.exitsBy[wb.you] === 1, 'per-player exit stats tracked');

  b.send({ type: 'next' });
  const next = await a.wait((m) => m.type === 'state' && m.levelIndex === 1, 'level 2');
  check(next.status === 'ready' && next.level.name === 'Wide Load', 'anyone can advance to the next level');

  a.send({ type: 'level', index: next.campaign });
  const locked = await Promise.race([
    a.wait((m) => m.type === 'loading' && m.levelIndex === next.campaign, 'loading').then(() => 'loaded'),
    new Promise((r) => setTimeout(() => r('ignored'), 400)),
  ]);
  check(locked === 'ignored', 'locked levels cannot be selected');

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
  check(clamped.levelIndex === 1 && clamped.unlocked === clamped.campaign + 200, 'resume values are clamped');

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
  g.send({ type: 'join', name: 'Gus', room: 'QQEE', resume: { levelIndex: next.campaign, unlocked: next.campaign } });
  const genNotice = await g.wait((m) => m.type === 'loading' || m.type === 'state', 'loading notice');
  check(genNotice.type === 'loading', 'joining a room that is still generating gets a loading notice');
  const endless = await g.wait((m) => m.type === 'state', 'rebuilt endless room');
  check(endless.levelIndex === next.campaign && endless.level.name.startsWith('Endless'), 'rebuilding a room into an endless level works');

  g.send({ type: 'level', index: next.campaign + 0 });
  g.send({ type: 'level', index: next.campaign - 1 });
  g.send({ type: 'level', index: next.campaign - 2 });
  await g.wait((m) => m.type === 'loading', 'endless reload');
  const settled = await g.wait((m) => m.type === 'state', 'reload settled');
  const extraLoad = await Promise.race([
    g.wait((m) => m.type === 'loading', 'extra load').then(() => true),
    new Promise((r) => setTimeout(() => r(false), 400)),
  ]);
  check(settled.levelIndex === next.campaign && !extraLoad, 'level picks are ignored while a level is generating');

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

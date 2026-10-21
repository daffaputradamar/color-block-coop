// Browser client: lobby, WebSocket sync, drag input with local prediction, HUD.
import {
  PALETTE, SIDES, EMOTES, buildOcc, canStep, moveStep, findExit, moveBlocker, blockAt,
} from '/shared/logic.js';
import { computeLayout, drawScene } from './render.js';
import { sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const S = {
  ws: null,
  me: null,
  code: null,
  name: '',
  joined: false,
  fatal: false,
  level: null,
  blocks: [],
  status: 'loading',
  endsAt: null,
  offset: 0,
  mode: 'split',
  owners: {},
  players: [],
  grabs: {},
  levelIndex: 0,
  unlocked: 0,
  seed: '',
  result: null,
  disp: new Map(),
  drag: null,
  cursors: new Map(),
  myCursor: null,
  effects: [],
  pings: [],
  bubbles: [],
  shakes: new Map(),
  showGlyphs: store.get('cb-glyphs') === '1',
};
let layout = null;

// The game server is the host that served this page, unless config.js points at a separate
// one (the Vercel frontend talks to the Render server).
const SERVER_URL = (window.CB_CONFIG?.serverUrl || location.origin).replace(/\/+$/, '');
const WS_URL = `${SERVER_URL.replace(/^http/, 'ws')}/ws`;
const WAKE_TIMEOUT = 120_000;
const WAKE_TEXT = 'Waking up the game server… free hosting can take up to a minute.';
let retryDelay = 500;
// Identifies this tab across reconnects so the server can hand back our seat. Memory only:
// two tabs must not share it. (getRandomValues also works on plain-http LAN addresses.)
const SESSION = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const cleanSeed = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const cleanCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);

// A free-tier server sleeps when idle, so start waking it while the player types their name.
if (window.CB_CONFIG?.serverUrl) fetch(`${SERVER_URL}/healthz`, { cache: 'no-store' }).catch(() => {});

// ---------- lobby ----------

const params = new URLSearchParams(location.search);
const savedName = store.get('cb-name') ?? '';
$('name-input').value = savedName;
const inviteCode = cleanCode(params.get('room'));
if (inviteCode) $('code-input').value = inviteCode;

function lobbyMessage(text, kind = 'error') {
  const el = $('lobby-error');
  el.textContent = text;
  el.classList.toggle('info', kind === 'info');
}

function setLobbyBusy(busy) {
  S.connecting = busy;
  if (!busy) clearTimeout(S.wakeHint);
  $('create-btn').disabled = busy;
  $('join-btn').disabled = busy;
}

function resetSession() {
  Object.assign(S, { joined: false, me: null, level: null, blocks: [], players: [], grabs: {}, owners: {}, drag: null });
  S.cursors.clear();
}

function startJoin(code) {
  if (S.connecting) return;
  const name = $('name-input').value.trim();
  if (!name) {
    lobbyMessage('Pick a name first.');
    $('name-input').focus();
    return;
  }
  store.set('cb-name', name);
  // A join from the lobby is always a fresh session, even right after being sent back here.
  resetSession();
  S.name = name;
  S.code = code || null;
  // Only a new room takes a seed; joining an existing room plays its seed.
  S.createSeed = code ? null : cleanSeed($('seed-input').value) || null;
  S.fatal = false;
  S.connectStart = Date.now();
  retryDelay = 500;
  setLobbyBusy(true);
  lobbyMessage('Connecting…', 'info');
  clearTimeout(S.wakeHint);
  S.wakeHint = setTimeout(() => !S.joined && lobbyMessage(WAKE_TEXT, 'info'), 4000);
  sfx.unlock();
  connect();
}

$('create-btn').onclick = () => startJoin(null);
$('join-btn').onclick = () => {
  const code = cleanCode($('code-input').value);
  if (code.length < 4) {
    lobbyMessage('Room codes are 4 letters.');
    return;
  }
  startJoin(code);
};
$('code-input').addEventListener('keydown', (e) => e.key === 'Enter' && $('join-btn').click());
$('seed-input').addEventListener('keydown', (e) => e.key === 'Enter' && $('create-btn').click());
$('name-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if ($('code-input').value.trim()) $('join-btn').click();
  else $('create-btn').click();
});
if (inviteCode && savedName) {
  // A cut-off invite link must not quietly create a new room.
  if (inviteCode.length >= 4) startJoin(inviteCode);
  else lobbyMessage('Room codes are 4 letters.');
} else $('name-input').focus();

// ---------- networking ----------

function connect() {
  const ws = new WebSocket(WS_URL);
  S.ws = ws;
  ws.onopen = () => {
    retryDelay = 500;
    // After a server restart the room is gone; offer our progress so it can be rebuilt.
    const resume = S.level ? { levelIndex: S.levelIndex, unlocked: S.unlocked, seed: S.seed } : undefined;
    ws.send(JSON.stringify({ type: 'join', room: S.code, name: S.name, session: SESSION, seed: S.createSeed, resume }));
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.ws !== ws || S.fatal) return;
    S.drag = null;
    if (!S.joined) {
      if (Date.now() - S.connectStart >= WAKE_TIMEOUT) {
        setLobbyBusy(false);
        lobbyMessage('Could not reach the game server. Try again in a moment.');
        return;
      }
      lobbyMessage(WAKE_TEXT, 'info');
      // Browsers hide why a socket was refused, so ask the server whether it is awake and
      // accepts this page's origin before waiting any longer.
      serverHealth().then((health) => {
        if (S.ws !== ws || S.joined) return;
        if (health === 'origin-refused') {
          setLobbyBusy(false);
          lobbyMessage('The game server refused this page. If you host it, add this site to ALLOWED_ORIGINS.');
          return;
        }
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(5000, retryDelay * 2);
      });
      return;
    }
    $('conn').classList.remove('hidden');
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(5000, retryDelay * 2);
  };
}

function send(msg) {
  if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(msg));
}

// 'ok', 'origin-refused', or 'down' (asleep, booting, or unreachable).
async function serverHealth() {
  try {
    const res = await fetch(`${SERVER_URL}/healthz`, { cache: 'no-store' });
    const body = res.ok ? (await res.text()).trim() : '';
    return body === 'ok' || body === 'origin-refused' ? body : 'down';
  } catch {
    return 'down';
  }
}

// Free hosting sleeps after 15 idle minutes and may not count WebSocket pongs as activity,
// so an open game sends a tiny message now and then to keep its room alive.
setInterval(() => S.joined && send({ type: 'hb' }), 4 * 60 * 1000);

const playerById = (id) => S.players.find((p) => p.id === id);

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      S.me = msg.you;
      S.code = msg.code;
      S.joined = true;
      // Ids change when a restarted server rebuilds the room, so don't diff the next
      // player list against the old one (that would toast everyone as joined and left).
      S.players = [];
      setLobbyBusy(false);
      lobbyMessage('');
      history.replaceState(null, '', `?room=${msg.code}`);
      $('lobby').classList.add('hidden');
      $('game').classList.remove('hidden');
      $('conn').classList.add('hidden');
      $('room-code').textContent = msg.code;
      resize();
      break;
    case 'error':
      S.fatal = true;
      S.ws?.close();
      setLobbyBusy(false);
      $('game').classList.add('hidden');
      $('lobby').classList.remove('hidden');
      lobbyMessage(msg.text);
      break;
    case 'loading':
      S.status = 'loading';
      S.drag = null;
      $('result').classList.add('hidden');
      showHint('Building a fresh puzzle…');
      break;
    case 'state':
      applyState(msg);
      break;
    case 'moved': {
      if (msg.by && msg.by === S.me) break;
      const b = S.blocks[msg.id];
      if (b) {
        b.x = msg.x;
        b.y = msg.y;
      }
      break;
    }
    case 'grab':
      S.grabs[msg.id] = msg.by;
      break;
    case 'release':
      delete S.grabs[msg.id];
      if (S.drag?.id === msg.id) S.drag = null;
      break;
    case 'deny':
      onDeny(msg);
      break;
    case 'cursor': {
      const c = S.cursors.get(msg.pid) ?? {};
      S.cursors.set(msg.pid, { ...c, x: msg.x, y: msg.y, t: performance.now() });
      break;
    }
    case 'ping': {
      const p = playerById(msg.pid);
      S.pings.push({ x: msg.x, y: msg.y, color: p?.color ?? '#fff', t0: performance.now() });
      sfx.ping();
      break;
    }
    case 'emote':
      onEmote(msg.pid, EMOTES[msg.i]);
      break;
    case 'notice':
      toast(msg.text);
      break;
  }
}

function applyState(msg) {
  const now = performance.now();
  const prevStatus = S.status;
  const fresh = !S.level || msg.levelIndex !== S.levelIndex || (msg.status === 'ready' && prevStatus !== 'ready');

  // Exit animations use the board as it was just before this update.
  for (const e of msg.events ?? []) {
    const old = S.blocks[e.id];
    const door = msg.level.doors[e.door];
    if (!old || !door) continue;
    const dir = SIDES[door.side];
    const ext = {
      w: Math.max(...old.cells.map((c) => c[0])) + 1,
      h: Math.max(...old.cells.map((c) => c[1])) + 1,
    };
    S.effects.push({
      kind: 'exit',
      t0: now,
      dur: 420,
      x: e.x,
      y: e.y,
      dir,
      ext,
      block: { ...old, color: e.color, layers: [], ice: 0, axis: null, hasKey: false, lock: false },
    });
    const cx = e.x + ext.w / 2 + (dir[0] * ext.w) / 2;
    const cy = e.y + ext.h / 2 + (dir[1] * ext.h) / 2;
    const parts = Array.from({ length: 22 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = 1 + Math.random() * 2.5;
      return {
        vx: Math.cos(a) * v + dir[0] * 1.5,
        vy: Math.sin(a) * v + dir[1] * 1.5 - 1,
        s: 4 + Math.random() * 6,
        c: Math.random() < 0.3 ? '#fff' : PALETTE[e.color].base,
      };
    });
    S.effects.push({ kind: 'particles', t0: now, dur: 750, x: cx, y: cy, parts });
    if (e.peeled) sfx.peel();
    else sfx.exit();
  }

  // Keep my own dragged block where I predicted it; the server corrects me if needed.
  let keep = null;
  if (S.drag && !fresh) {
    const mine = S.blocks[S.drag.id];
    const next = msg.blocks[S.drag.id];
    if (mine && next && !next.gone && msg.grabs[S.drag.id] === S.me) keep = { x: mine.x, y: mine.y };
    else S.drag = null;
  }
  if (fresh) {
    S.drag = null;
    S.disp.clear();
    S.effects = S.effects.filter((e) => e.kind !== 'exit');
  }

  const prevPlayers = S.players;
  S.level = msg.level;
  S.blocks = msg.blocks;
  if (keep) Object.assign(S.blocks[S.drag.id], keep);
  S.status = msg.status;
  S.endsAt = msg.endsAt;
  S.offset = msg.now - Date.now();
  S.mode = msg.mode;
  S.owners = msg.owners;
  S.players = msg.players;
  S.grabs = msg.grabs;
  S.levelIndex = msg.levelIndex;
  S.unlocked = msg.unlocked;
  S.seed = msg.seed;
  S.result = msg.result;

  if (prevPlayers.length) {
    for (const p of S.players) {
      if (!prevPlayers.some((q) => q.id === p.id)) {
        toast(`${p.name} joined the room`);
        sfx.join();
      }
    }
    for (const p of prevPlayers) if (!S.players.some((q) => q.id === p.id)) toast(`${p.name} left`);
  }
  for (const pid of S.cursors.keys()) if (!playerById(pid)) S.cursors.delete(pid);

  if (fresh) {
    resize();
    const owned = Object.entries(S.owners).filter(([, pid]) => pid === S.me).map(([c]) => c);
    let hint = S.level.hint ?? 'Drag blocks into matching doors. The timer starts on the first move.';
    if (owned.length) hint += ` You control ${owned.map((c) => PALETTE[c].glyph + ' ' + c).join(', ')}.`;
    showHint(hint, 9000);
  }

  if (S.status === 'won' && prevStatus !== 'won') {
    sfx.win();
    setTimeout(showResult, 450);
  } else if (S.status === 'lost' && prevStatus !== 'lost') {
    sfx.lose();
    showResult();
  } else if (S.status === 'ready' || S.status === 'playing') {
    $('result').classList.add('hidden');
  }
  renderHud();
}

// ---------- HUD ----------

function renderHud() {
  const L = S.level;
  $('level-num').textContent = `Level ${S.levelIndex + 1}`;
  $('seed-btn').textContent = `Seed ${S.seed}`;
  $('level-name').textContent = L.name;

  for (const btn of $('mode-seg').querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.mode === S.mode);

  const wrap = $('players');
  wrap.replaceChildren();
  for (const p of S.players) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (p.id === S.me ? ' me' : '');
    chip.dataset.pid = p.id;
    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = p.color;
    av.textContent = p.name[0].toUpperCase();
    const nm = document.createElement('span');
    nm.textContent = p.id === S.me ? `${p.name} (you)` : p.name;
    chip.append(av, nm);
    const owns = Object.entries(S.owners).filter(([, pid]) => pid === p.id).map(([c]) => c);
    if (owns.length) {
      const box = document.createElement('span');
      box.className = 'owns';
      for (const c of owns) {
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = PALETTE[c].base;
        sw.title = c;
        if (S.showGlyphs) sw.textContent = PALETTE[c].glyph;
        box.append(sw);
      }
      chip.append(box);
    }
    wrap.append(chip);
  }
  renderPicker();
}

// Levels are generated from the seed, so only their numbers are known ahead of time:
// everything up to the furthest level reached, plus the next one (locked until cleared).
function renderPicker() {
  $('picker-seed').textContent = S.seed;
  const grid = $('picker-grid');
  grid.replaceChildren();
  for (let i = 0; i <= S.unlocked + 1 && i < 500; i++) {
    const b = document.createElement('button');
    b.className = 'lvl' + (i === S.levelIndex ? ' current' : '');
    b.disabled = i > S.unlocked;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = i > S.unlocked ? `🔒 ${i + 1}` : String(i + 1);
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = i === S.levelIndex ? S.level.name : i > S.unlocked ? 'Clear the last one first' : 'Level ' + (i + 1);
    b.append(n, t);
    b.onclick = () => {
      send({ type: 'level', index: i });
      $('picker').classList.add('hidden');
    };
    grid.append(b);
  }
}

function showResult() {
  const r = S.result ?? {};
  const won = S.status === 'won';
  $('result-title').textContent = won ? 'Board cleared!' : "Time's up!";
  const stars = won ? r.stars : 0;
  $('result-stars').innerHTML = [0, 1, 2].map((i) => `<span class="${i < stars ? 'on' : 'off'}">★</span>`).join('');
  $('result-sub').textContent = won
    ? `${Math.ceil(r.timeLeft / 1000)}s to spare. Teamwork!`
    : 'So close. Regroup and try again together.';
  const stats = $('result-stats');
  stats.replaceChildren();
  for (const p of S.players) {
    const n = r.exitsBy?.[p.id] ?? 0;
    const chip = document.createElement('div');
    chip.className = 'chip';
    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = p.color;
    av.textContent = p.name[0].toUpperCase();
    const t = document.createElement('span');
    t.textContent = `${p.name}: ${n} block${n === 1 ? '' : 's'}`;
    chip.append(av, t);
    stats.append(chip);
  }
  $('result-next').classList.toggle('hidden', !won);
  $('result-retry').textContent = won ? 'Replay' : 'Try again';
  $('result-retry').classList.toggle('primary', !won);
  $('result').classList.remove('hidden');
}

let hintTimer = null;
function showHint(text, ms = 0) {
  const el = $('hint');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(hideHint, ms);
}
function hideHint() {
  $('hint').classList.add('hidden');
}

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = text;
  const box = $('toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => (el.style.opacity = '0'), 2200);
  setTimeout(() => el.remove(), 2700);
}

function onDeny(msg) {
  if (S.drag?.id === msg.id) S.drag = null;
  if (S.grabs[msg.id] === S.me) delete S.grabs[msg.id];
  denyFeedback(msg.id, msg.reason, msg);
}

function denyFeedback(id, reason, extra = {}) {
  S.shakes.set(id, performance.now());
  sfx.deny();
  const who = playerById(extra.owner)?.name ?? 'a teammate';
  const b = S.blocks[id];
  const text = {
    owner: `That's ${who}'s color. Ask them to move it!`,
    held: `${who} is moving that one`,
    ice: `Frozen! Thaws after ${extra.ice ?? b?.ice} more block${(extra.ice ?? b?.ice) === 1 ? '' : 's'} leave`,
    lock: 'Locked. Get every 🔑 block out first',
  }[reason];
  if (text) toast(text, true);
}

function onEmote(pid, text) {
  if (!text) return;
  S.bubbles.push({ pid, text, t0: performance.now() });
  sfx.emote();
  const chip = document.querySelector(`.chip[data-pid="${pid}"]`);
  if (chip) {
    chip.querySelector('.bubble')?.remove();
    const b = document.createElement('span');
    b.className = 'bubble';
    b.textContent = text;
    chip.append(b);
    setTimeout(() => b.remove(), 2200);
  }
}

// ---------- controls ----------

EMOTES.forEach((text, i) => {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = `Emote (${i + 1})`;
  b.onclick = () => send({ type: 'emote', i });
  $('emotes').append(b);
});
window.addEventListener('keydown', (e) => {
  if (!S.joined || e.target.tagName === 'INPUT') return;
  const n = Number(e.key);
  if (n >= 1 && n <= EMOTES.length) send({ type: 'emote', i: n - 1 });
  if (e.key === 'Escape') $('picker').classList.add('hidden');
});

$('mode-seg').addEventListener('click', (e) => {
  const mode = e.target.closest('button')?.dataset.mode;
  if (mode && mode !== S.mode) send({ type: 'mode', mode });
});
$('retry-btn').onclick = () => send({ type: 'retry' });
$('result-retry').onclick = () => send({ type: 'retry' });
$('result-next').onclick = () => send({ type: 'next' });
// Leaving closes the socket for good (no auto-reconnect); teammates see "<name> left".
$('leave-btn').onclick = () => {
  if (!confirm('Leave this room?')) return;
  S.fatal = true;
  S.ws?.close();
  resetSession();
  history.replaceState(null, '', location.pathname);
  for (const id of ['game', 'result', 'picker', 'conn']) $(id).classList.add('hidden');
  $('lobby').classList.remove('hidden');
  lobbyMessage('You left the room.', 'info');
};

$('levels-btn').onclick = () => {
  renderPicker();
  $('picker').classList.remove('hidden');
};
$('picker-close').onclick = () => $('picker').classList.add('hidden');
$('picker').addEventListener('click', (e) => e.target === $('picker') && $('picker').classList.add('hidden'));

$('mute-btn').textContent = sfx.muted ? '🔇' : '🔊';
$('mute-btn').onclick = () => {
  $('mute-btn').textContent = sfx.toggle() ? '🔇' : '🔊';
};
$('glyph-btn').classList.toggle('off', !S.showGlyphs);
$('glyph-btn').onclick = () => {
  S.showGlyphs = !S.showGlyphs;
  store.set('cb-glyphs', S.showGlyphs ? '1' : '0');
  $('glyph-btn').classList.toggle('off', !S.showGlyphs);
  renderHud();
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

$('room-btn').onclick = async () => {
  await copyText(`${location.origin}/?room=${S.code}`);
  toast('Invite link copied. Send it to a friend!');
};
$('seed-btn').onclick = async () => {
  await copyText(S.seed);
  toast(`Seed ${S.seed} copied. Type it when creating a room to get these same puzzles.`);
};

// ---------- board input ----------

function toBoard(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - layout.ox) / layout.cell, y: (e.clientY - r.top - layout.oy) / layout.cell };
}

function localDeny(b) {
  const blocked = moveBlocker(S.blocks, b);
  if (blocked) return { reason: blocked };
  const holder = S.grabs[b.id];
  if (holder && holder !== S.me) return { reason: 'held', owner: holder };
  const owner = S.owners[b.color];
  if (owner && owner !== S.me) return { reason: 'owner', owner };
  return null;
}

let lastPing = 0;
canvas.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  if (!S.level || !layout || (S.status !== 'ready' && S.status !== 'playing')) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const p = toBoard(e);
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const b = blockAt(S.level, S.blocks, cx, cy);
  if (!b) {
    const inside = cx >= 0 && cy >= 0 && cx < S.level.w && cy < S.level.h;
    if (inside && performance.now() - lastPing > 350) {
      lastPing = performance.now();
      send({ type: 'ping', x: p.x, y: p.y });
    }
    return;
  }
  const denied = localDeny(b);
  if (denied) {
    denyFeedback(b.id, denied.reason, denied);
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  S.drag = { id: b.id, offX: p.x - b.x, offY: p.y - b.y, pointerId: e.pointerId, target: { x: b.x, y: b.y } };
  S.grabs[b.id] = S.me;
  send({ type: 'grab', id: b.id });
  sfx.grab();
  hideHint();
});

let lastCursorSend = 0;
canvas.addEventListener('pointermove', (e) => {
  if (!layout || !S.level) return;
  const p = toBoard(e);
  S.myCursor = p;
  const now = performance.now();
  if (now - lastCursorSend > 50) {
    lastCursorSend = now;
    send({ type: 'cursor', x: p.x, y: p.y });
  }
  if (S.drag && e.pointerId === S.drag.pointerId) dragTo(p);
  else {
    const b = blockAt(S.level, S.blocks, Math.floor(p.x), Math.floor(p.y));
    canvas.style.cursor = !b ? 'crosshair' : localDeny(b) ? 'not-allowed' : 'grab';
  }
});

function endDrag(e) {
  if (!S.drag || e.pointerId !== S.drag.pointerId) return;
  const id = S.drag.id;
  S.drag = null;
  if (S.grabs[id] === S.me) delete S.grabs[id];
  send({ type: 'release', id });
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Walk the block toward the pointer one cell at a time, the same way the server will.
function dragTo(p) {
  const b = S.blocks[S.drag.id];
  if (!b || b.gone || (S.status !== 'ready' && S.status !== 'playing')) {
    S.drag = null;
    return;
  }
  const tx = p.x - S.drag.offX;
  const ty = p.y - S.drag.offY;
  S.drag.target = { x: tx, y: ty };
  const occ = buildOcc(S.level, S.blocks);
  const steps = [];
  let exiting = false;
  for (let i = 0; i < 30; i++) {
    const dx = Math.round(tx) - b.x;
    const dy = Math.round(ty) - b.y;
    if (!dx && !dy) break;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const tries = Math.abs(dx) >= Math.abs(dy) ? [[sx, 0], [0, sy]] : [[0, sy], [sx, 0]];
    const step = tries.find(([mx, my]) => (mx || my) && canStep(S.level, occ, S.blocks, b, mx, my));
    if (!step) break;
    moveStep(occ, S.level, b, step[0], step[1]);
    steps.push(step);
    if (findExit(S.level, occ, b) >= 0) {
      exiting = true;
      break;
    }
  }
  if (steps.length) {
    send({ type: 'move', id: b.id, steps });
    sfx.step();
  }
  if (exiting) {
    send({ type: 'release', id: b.id });
    S.drag = null;
  }
}

// ---------- frame loop ----------

function resize() {
  const stage = $('stage');
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.level) {
    // Keep a band above the board free for the hint banner so it never covers top doors.
    const band = h > 360 ? 46 : 0;
    layout = computeLayout(w, h - band, S.level);
    layout.oy += band;
  }
}
window.addEventListener('resize', resize);

let lastFrame = performance.now();
let lastTimerText = '';
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!S.level || !layout || $('game').classList.contains('hidden')) return;

  const k = 1 - Math.exp(-dt * 22);
  for (const b of S.blocks) {
    if (b.gone) continue;
    const d = S.disp.get(b.id);
    if (!d) S.disp.set(b.id, { x: b.x, y: b.y });
    else {
      d.x += (b.x - d.x) * k;
      d.y += (b.y - d.y) * k;
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawScene(ctx, S, layout, now);
  updateTimer();
}
requestAnimationFrame(frame);

function updateTimer() {
  const el = $('timer');
  const fill = $('timebar-fill');
  let text;
  let frac = 1;
  if (S.status === 'ready') text = `${fmt(S.level.time * 1000)} · ready`;
  else if (S.status === 'playing' && S.endsAt) {
    const left = Math.max(0, S.endsAt - (Date.now() + S.offset));
    frac = left / (S.level.time * 1000);
    text = fmt(left);
  } else if (S.status === 'won') {
    text = 'Cleared!';
    frac = (S.result?.timeLeft ?? 0) / (S.level.time * 1000);
  } else if (S.status === 'lost') {
    text = '0:00';
    frac = 0;
  } else text = '…';
  if (text !== lastTimerText) {
    $('timer-text').textContent = text;
    lastTimerText = text;
  }
  el.classList.toggle('idle', S.status === 'ready');
  el.classList.toggle('low', S.status === 'playing' && frac < 0.2);
  fill.style.transform = `scaleX(${frac})`;
  fill.style.background = frac < 0.2 ? 'var(--danger)' : frac < 0.5 ? 'var(--accent)' : 'var(--good)';
}

function fmt(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

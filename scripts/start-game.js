// Starts the game server and, if setup-tunnel.bat was run, the Cloudflare Tunnel too.
// Usage: node scripts/start-game.js   (or double-click start-game.bat). Ctrl+C stops both.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const settingsPath = join(root, 'tunnel', 'settings.json');
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null;
const port = Number(settings?.port ?? process.env.PORT ?? 3000);
const isWindows = process.platform === 'win32';
const children = [];

function stopAll(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stopAll(0));

function prefixed(stream, label, filter = () => true) {
  createInterface({ input: stream }).on('line', (line) => filter(line) && console.log(`[${label}] ${line}`));
}

function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(p);
  });
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url, { cache: 'no-store' })).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function openBrowser(url) {
  if (isWindows) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
}

// 1. Dependencies (first run only).
if (!existsSync(join(root, 'node_modules', 'ws'))) {
  console.log('Installing dependencies...');
  const res = spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit', shell: isWindows });
  if (res.status !== 0) process.exit(1);
}

if (!(await portFree(port))) {
  console.error(`Port ${port} is already in use. Close the other program (or an older game window) and try again.`);
  process.exit(1);
}

// 2. Game server.
const game = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) } });
children.push(game);
prefixed(game.stdout, 'game');
prefixed(game.stderr, 'game');
game.on('exit', (code) => {
  console.log(`[game] stopped${code ? ` (exit code ${code})` : ''}.`);
  stopAll(code ?? 0);
});

// 3. Tunnel: our own config if setup-tunnel.bat was run, otherwise maybe the Windows service.
let publicUrl = null;
if (settings) {
  publicUrl = `https://${settings.hostname}`;
  const tunnel = spawn('cloudflared', ['tunnel', '--config', join(root, 'tunnel', 'config.yml'), 'run'], { cwd: root });
  children.push(tunnel);
  tunnel.on('error', (err) => {
    console.error(err.code === 'ENOENT' ? '[tunnel] cloudflared is not installed: winget install --id Cloudflare.cloudflared -e' : `[tunnel] ${err.message}`);
    stopAll(1);
  });
  // cloudflared is chatty; show connections, warnings and errors only.
  prefixed(tunnel.stderr, 'tunnel', (l) => / ERR | WRN |Registered tunnel connection/.test(l));
  prefixed(tunnel.stdout, 'tunnel', (l) => / ERR | WRN /.test(l));
  tunnel.on('exit', (code) => {
    if (code === null) return;
    console.log(`[tunnel] stopped (exit code ${code}).`);
    stopAll(code);
  });
} else if (isWindows && /RUNNING/.test(spawnSync('sc', ['query', 'cloudflared'], { encoding: 'utf8' }).stdout ?? '')) {
  console.log('[tunnel] Using the Cloudflared Windows service (set up in the Cloudflare dashboard).');
} else {
  console.log('[tunnel] Not set up. Only this PC can play. Run setup-tunnel.bat to put the game online.');
}

// 4. Ready.
const localUrl = `http://localhost:${port}`;
if (!(await waitFor(`${localUrl}/healthz`, 15000))) {
  console.error('The game server did not start. See the [game] messages above.');
  stopAll(1);
} else {
  if (publicUrl && !(await waitFor(`${publicUrl}/healthz`, 30000))) {
    console.log(`[tunnel] ${publicUrl} is not answering yet. If this keeps happening, check the [tunnel] messages.`);
  }
  console.log('');
  console.log(`  Game running at  ${publicUrl ?? localUrl}`);
  if (publicUrl) console.log(`  (on this PC also ${localUrl})`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  if (!process.argv.includes('--no-open')) openBrowser(publicUrl ?? localUrl);
}

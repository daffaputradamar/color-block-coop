// One-time Cloudflare Tunnel setup for hosting the game from this PC.
// Usage: node scripts/setup-tunnel.js [hostname] [port]   (or double-click setup-tunnel.cmd)
// Needs: cloudflared installed, and the hostname's domain using Cloudflare DNS.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const TUNNEL_NAME = 'color-block';
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'tunnel');
const cfDir = join(homedir(), '.cloudflared');

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function cloudflared(args, capture = false) {
  const res = spawnSync('cloudflared', args, { stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (res.error?.code === 'ENOENT') {
    fail('cloudflared is not installed. Install it, open a NEW terminal, and run this again:\n  winget install --id Cloudflare.cloudflared -e');
  }
  return res;
}

function findTunnel() {
  const res = cloudflared(['tunnel', 'list', '--output', 'json'], true);
  if (res.status !== 0) fail('Could not list tunnels (see the error above).');
  const list = JSON.parse(res.stdout || '[]');
  // Live tunnels report deleted_at as the zero time "0001-01-01T00:00:00Z".
  const live = (t) => !t.deleted_at || t.deleted_at.startsWith('0001-');
  return list.find((t) => t.name === TUNNEL_NAME && live(t));
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let hostname = (process.argv[2] ?? '').trim().toLowerCase();
if (!hostname) hostname = (await rl.question('Public address for the game (e.g. play.example.com): ')).trim().toLowerCase();
let port = Number(process.argv[3]);
if (!port) port = Number((await rl.question('Local port for the game server [3000]: ')).trim()) || 3000;
rl.close();
if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname)) fail(`"${hostname}" is not a valid hostname.`);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`"${port}" is not a valid port.`);

cloudflared(['--version']);

// 1. Authorize this PC for your Cloudflare account (opens a browser once).
if (!existsSync(join(cfDir, 'cert.pem'))) {
  console.log('\nA browser window will open. Log in to Cloudflare and pick your domain.');
  if (cloudflared(['tunnel', 'login']).status !== 0) fail('Cloudflare login failed.');
}

// 2. Create the tunnel once; reuse it on later runs.
let tunnel = findTunnel();
if (!tunnel) {
  console.log(`\nCreating tunnel "${TUNNEL_NAME}"...`);
  if (cloudflared(['tunnel', 'create', TUNNEL_NAME]).status !== 0) fail('Could not create the tunnel.');
  tunnel = findTunnel();
  if (!tunnel) fail('The tunnel was created but could not be found. Run this script again.');
}
const credentials = join(cfDir, `${tunnel.id}.json`);
if (!existsSync(credentials)) {
  fail(`Tunnel "${TUNNEL_NAME}" exists but its credentials (${credentials}) are not on this PC.\n` +
    `Delete it with "cloudflared tunnel delete ${TUNNEL_NAME}" and run this again.`);
}

// 3. Point the hostname at the tunnel (creates a CNAME in Cloudflare DNS).
console.log(`\nPointing ${hostname} at the tunnel...`);
if (cloudflared(['tunnel', 'route', 'dns', TUNNEL_NAME, hostname]).status !== 0) {
  console.warn(`\nCould not create the DNS record. If ${hostname} already has a record in Cloudflare DNS, ` +
    'delete it in the dashboard and run this again.');
}

// 4. Write a project-local config so other tunnels on this PC are untouched.
mkdirSync(outDir, { recursive: true });
const configPath = join(outDir, 'config.yml');
writeFileSync(configPath, [
  '# Written by scripts/setup-tunnel.js. Re-run setup-tunnel.cmd to change it.',
  `tunnel: ${tunnel.id}`,
  `credentials-file: '${credentials}'`,
  'ingress:',
  `  - hostname: ${hostname}`,
  `    service: http://localhost:${port}`,
  '  - service: http_status:404',
  '',
].join('\n'));
writeFileSync(join(outDir, 'settings.json'), JSON.stringify({ name: TUNNEL_NAME, hostname, port }, null, 2) + '\n');

if (cloudflared(['tunnel', '--config', configPath, 'ingress', 'validate']).status !== 0) fail('The tunnel config is invalid.');
console.log(`\nAll set. Run start-game.cmd, then share https://${hostname}`);

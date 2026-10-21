# Color Block Co-op

A real-time **co-op** web remake of the *Color Block Jam* sliding puzzle. Slide every colored block
out through a door of its own color before the timer runs out, together with up to 3 friends.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000, enter a name, **Create a room**, then click the room code to copy an
invite link (`/?room=ABCD`). Friends open the link and they're in. Use `PORT=4000 npm start` for
another port.

To play with friends who aren't on your network, host it from your PC (next section) or deploy
it (further below).

## Host from your PC with a Cloudflare Tunnel (Windows)

Puts the game online at your own address, e.g. `https://play.example.com`, straight from this PC.
No server, no card. Needs a domain whose DNS is on Cloudflare (free plan) and `cloudflared`:

```bash
winget install --id Cloudflare.cloudflared -e
```

1. **Once:** double-click `setup-tunnel.bat`. It asks for the address and port, opens a browser to
   log in to Cloudflare, creates a tunnel called `color-block` (or reuses it), adds the DNS record
   and writes `tunnel/config.yml` inside this folder. Your other tunnels and your global
   `~/.cloudflared/config.yml` are left alone.
2. **Every time you play:** double-click `start-game.bat`. It installs dependencies on first run,
   starts the game server and the tunnel together, waits until your address answers, and opens it.
   Press **Ctrl+C** (or close the window) to stop both.

The game is online only while that window is open and the PC is awake. Without a tunnel set up,
`start-game.bat` still runs the game for this PC. If you created the tunnel in the Cloudflare
dashboard instead (it runs as the `Cloudflared` Windows service), `start-game.bat` detects the
service and only starts the game server. For a quick throwaway link without a domain:
`cloudflared tunnel --url http://localhost:3000`.

## Deploy: your domain on Vercel, game server on Railway

The game server keeps each room in memory and holds long-lived WebSockets, so it runs on Railway
as one Node process. Vercel serves only the static page (`dist/`, built by
`scripts/build-static.js`) on your own domain. Vercel Functions can't host the server itself:
their sockets close at the function time limit, and players in one room can land on different
instances. Neither platform needs a credit card for this setup.

Both deploy from GitHub, so push this repo there first. The examples below use
`play.yourdomain.com` for the game; substitute your own domain.

### 1. Game server on Railway

Check [status.railway.com](https://status.railway.com) first: deploys queue or fail during outages.

1. Sign up at railway.com with **Login with GitHub** (no card). Railway checks your GitHub
   account automatically; if the dashboard says **Limited Trial**, open railway.com/verify before
   deploying.
2. Before creating anything, open **Workspace Settings** and set the preferred region to
   **Southeast Asia (Singapore)**. Region choice is only available during the 30-day trial.
3. **New Project > GitHub repo**, pick this repo, then choose **Add variables**, not *Deploy Now*,
   so the settings below are in place before the first build.
4. In the service's **Settings** (Railway ignores `railway.json` files in new projects, so these
   live in the dashboard):

   | Setting | Value |
   | --- | --- |
   | Source | branch `main`, root directory `/` |
   | Builder | Railpack (the default). Don't add a Dockerfile: Railway always prefers one. |
   | Watch paths | `/server.js`, `/shared/**`, `/package.json`, `/package-lock.json` (one per line) |
   | Custom start command | `node server.js` (not `npm start`: npm swallows the SIGTERM the server uses to hand players over on deploys) |
   | Healthcheck path / timeout | `/healthz` / `60` |
   | Restart policy | On Failure, 10 retries |
   | Serverless | **Enabled** (sleeps when nobody is playing; needed to fit the free credit) |
   | Scale > Regions | Southeast Asia (Singapore), 1 replica. Never more: rooms live in memory. |

5. **Variables:** add `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` = `10`. Leave `ALLOWED_ORIGINS`
   unset for now. Don't set `PORT` (Railway injects it), `VERCEL`, or `RAILPACK_SPA_OUTPUT_DIR`.
   Node 24 comes from `engines` in `package.json`.
6. Click **Deploy**. When it's active, go to **Settings > Networking > Generate Domain**. Opening
   `https://<name>.up.railway.app/healthz` should show `ok`.

### 2. Frontend on Vercel

1. Import the same repo, Root Directory at the repo root. `vercel.json` sets the Framework Preset
   to *Other*, skips `npm install` and builds `dist/`. The dashboard may show "Node" because of
   `server.js`; set it to **Other** too, and never remove `"framework": null`, or Vercel turns
   `server.js` into a Function.
2. Under **Settings > Environment Variables** add `GAME_SERVER_URL` =
   `https://<name>.up.railway.app` for Production and Preview, then deploy. The build fails on
   purpose if it's missing. The value is baked in at build time, so changing it needs a redeploy.

### 3. Your domain

1. In the Vercel project: **Settings > Domains > Add Domain** > `play.yourdomain.com`, connected to
   Production.
2. Find out who runs DNS for your domain (`nslookup -type=NS yourdomain.com`) and add the record
   there. For a subdomain it's a CNAME named `play` pointing to the **project-specific target Vercel
   shows** (looks like `<hash>.vercel-dns-0NN.com`; don't copy old values from tutorials). If DNS is
   on Cloudflare, set the record to **DNS only** (grey cloud). Remove any other A/AAAA/CNAME on `play`.
3. Wait for **Valid Configuration**. Vercel issues the HTTPS certificate on its own, usually within
   minutes.

Leave Deployment Protection on *Standard*: it keeps your domain public and only puts preview URLs
behind a Vercel login. Don't put your domain on Railway: the trial allows one custom domain and the
free plan none, so it would break after 30 days.

### 4. Lock the server to your site

In Railway **Variables**, set `ALLOWED_ORIGINS` to
`https://play.yourdomain.com,https://<project>.vercel.app` and deploy the staged change. If a page
shows "The game server refused this page", its exact origin is missing from that list. Preview
deployments will show that message, which is expected. Wildcards like
`https://color-block-coop-*-yourteam.vercel.app` work for testing, but aren't a lock: anyone can
claim a matching `vercel.app` name.

Invite links follow the page's address, so players share `https://play.yourdomain.com/?room=ABCD`.

### Free-tier notes

- **Trial, then Free.** The trial is 30 days with $5 of credit, then the Free plan gives $1 a month.
  A small Node process like this one should fit, but check **Usage** after the first week. When
  the trial ends, open the service and **Redeploy** if it shows as stopped, and check its region:
  the Free plan doesn't offer region choice, so it may end up in the US or EU (moves still feel
  instant because the browser predicts them). Keep this as your only Railway project; Free allows one.
- **Sleeping.** With no players for about 10 minutes the server sleeps, which wipes its rooms. The
  page wakes it on open and shows "Waking up the game server…" until it's back. An open tab keeps
  it awake, so close the game when you're done to save credit.
- **Restarts and deploys** wipe the rooms too. Connected players reconnect automatically and their
  room is rebuilt at the same level with the same unlocks; a game in progress restarts its board.
- **What redeploys.** With the watch paths above, commits that only touch `public/`, `scripts/` or
  docs don't restart the server, so you can ship page changes without dropping live games. Changes
  to `shared/` redeploy both, since the browser and the server share the rules.
- **Queued deploys.** Free accounts' builds can wait in a queue when Railway is busy ("Limited
  Access" in the dashboard). They run on their own; nothing that's already running is affected.

`render.yaml` describes the same server for Render, if you'd rather use it there. Render asks some
free accounts to verify a card.

To try the split locally, run the server on one port and the built page on another:

```bash
PORT=3060 ALLOWED_ORIGINS=http://localhost:5180 npm start
```

```bash
GAME_SERVER_URL=http://localhost:3060 npm run build
```

Then serve `dist/` with any static file server on port 5180.

## How it plays

- **Drag** a block. It slides cell by cell and stops at walls and other blocks. Blocks never rotate.
- A block leaves through a door of **its color**, but only when it touches that edge, the door is at
  least as wide as the block, and nothing is in the way.
- The shared timer starts on the first move. Clear the board for up to 3 stars.

Blockers, introduced one per level:

| Blocker | Rule |
| --- | --- |
| Arrow block | Moves only along its arrow (horizontal or vertical). |
| Frozen block | Can't move until its number reaches 0. It drops by 1 whenever any block exits. |
| Layered block | The outer color exits at its door and the block stays as the inner color, which needs its own door. |
| Lock & key | Locked blocks stay put until every 🔑 block has left the board. |
| Walls | Fixed cells that split the board. |

### Co-op

- **Split colors** (default): every color is assigned to one player. You can only move your colors,
  so you have to plan out loud. Owner initials appear on teammates' blocks, and a layered block can
  change hands when it peels.
- **Shared hands**: anyone moves anything. A block someone is holding is outlined in their color
  and locked to them.
- Live teammate cursors, **tap an empty tile to ping** it, and an emote bar (keys `1`–`6`).
- Anyone can restart, pick a level or advance. The end screen shows who cleared which blocks.
- The ◆ button adds a symbol to each color for color-blind play.

There are 12 handcrafted levels, then **Endless mode**: procedurally generated boards that get
bigger and add blockers as you go.

## How it's built

- `server.js`: static file server plus a `ws` WebSocket server. Each room is **authoritative**:
  it validates every grab and step, resolves exits, runs the timer and broadcasts state.
- `shared/logic.js`: the rules, imported by both the server and the browser. The browser predicts
  your own drag locally with the same code, and the server corrects it if a teammate got there first.
- `shared/solver.js`: best-first search that proves a board is solvable.
- `shared/generator.js`: Endless levels. Random boards are kept only if the solver clears them.
  Generation runs in a worker thread (`shared/gen-worker.js`).
- `public/`: vanilla JS client. Canvas renderer (`render.js`), synthesized sound (`sfx.js`), no
  bundler. `config.js` says where the game server is (empty means the page's own host).

## Scripts

- `npm run verify`: proves every handcrafted level is solvable and that each door sits on an open edge.
- `npm test`: `verify`, then a two-player end-to-end run of level 1 over real WebSockets, plus the
  deploy hooks (`/healthz`, the origin allowlist, rebuilding a room after a restart).
- `npm run build`: writes the static frontend to `dist/` (set `GAME_SERVER_URL` to point it at a
  separate game server).
- `UNLOCK_ALL=1 npm start`: every level is unlocked in new rooms (handy for testing levels).

Server environment variables: `PORT`, `ALLOWED_ORIGINS` (comma-separated, `*` matches part of one
domain label; empty allows any origin) and `UNLOCK_ALL`.

## Adding a level

Levels in `shared/levels.js` are ASCII grids: `.` is empty, `#` is a wall, and any other character
is a block. Block properties go in `blocks` (`color`, `layers`, `ice`, `axis: 'h'|'v'`, `lock`, `key`).
Doors are `{ side, at, len, color }`, where `at` is the first cell along that side. Run
`npm run verify` afterwards.

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

To play with friends who aren't on your network, deploy it (below), or expose your machine
temporarily with a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

## Deploy: frontend on Vercel, game server on Render

The game server keeps each room in memory and holds long-lived WebSockets, so it runs on Render as
one always-on Node process. Vercel serves only the static page (`dist/`, built by
`scripts/build-static.js`). Vercel Functions can't host the server itself: their sockets close at
the function time limit, and players in one room can land on different instances.

Both platforms deploy from Git, so first push this folder to a GitHub (or GitLab/Bitbucket) repo.

1. **Render (game server).** In the Render dashboard choose **New > Blueprint** and pick the repo.
   `render.yaml` creates a free web service in Singapore with health check `/healthz`. Check that
   the Free instance type is offered in Singapore before confirming, because the region can't be
   changed later. Leave `ALLOWED_ORIGINS` empty for now. Once it's live, copy the service URL,
   e.g. `https://color-block-coop.onrender.com` (opening `/healthz` there should show `ok`).
2. **Vercel (frontend).** Import the same repo with Root Directory left at the repo root.
   `vercel.json` sets the Framework Preset to *Other*, skips `npm install` and builds `dist/`.
   The dashboard may still show "Node" because of `server.js`; set it to **Other** too, and never
   remove `"framework": null`, or Vercel turns `server.js` into a Function. Under
   **Settings > Environment Variables** add `GAME_SERVER_URL` = your Render URL for Production and
   Preview, then deploy. The build fails on purpose if this variable is missing.
3. **Lock the server to your site.** Back on Render, set `ALLOWED_ORIGINS` to your Vercel production
   URL, e.g. `https://color-block-coop.vercel.app` (a bare host gets `https://` added). Saving
   redeploys. If a page shows "The game server refused this page", its origin is missing from the list.
   To test preview deployments you can add a wildcard such as
   `https://color-block-coop-*-yourteam.vercel.app`, but treat it as a convenience, not a lock:
   anyone can claim a `vercel.app` name that happens to match. The check only stops other websites
   from embedding your game, so for production list exact URLs.

Share the Vercel **production** URL with players: preview URLs sit behind Vercel's login.

Things to know about the free tier:

- The Render service sleeps after 15 minutes with no players and takes about a minute to wake.
  The page starts waking it as soon as it opens, and shows "Waking up the game server…" meanwhile.
- A restart or redeploy wipes the rooms in memory. Connected players reconnect automatically and
  their room is rebuilt at the same level with the same unlocks. A game in progress restarts its board.
- Commits that only touch `public/`, `scripts/`, docs or `vercel.json` don't redeploy Render (see
  `buildFilter` in `render.yaml`), so you can ship frontend changes without dropping live games.
  Changes to `shared/` redeploy both, since the browser and the server share the rules.
- Players in Indonesia get the static page from Vercel's CDN and talk to the Singapore server.

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

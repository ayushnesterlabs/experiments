# EXPERIMENTS — handoff notes (v1: multi-canvas)

Zero dependencies, no build step, no framework. Plus Jakarta Sans, white/monochrome, soft shadows.

```
server.js               zero-dep Node backend (node:http + node:sqlite, Node ≥22.5)
public/index.html       landing — create a canvas, open recent ones
public/app.html         the Experiments app (evolved from v0)
data/experiments.db     SQLite, created at runtime (gitignored)
experiments (1).html    the original single-file v0, kept for reference
```

Run it: `node server.js` → http://localhost:4321 (or `PORT=… node server.js`).

## What it is
**Experiments** is now multi-canvas: anyone hits `/`, names a canvas, and gets a link at `/c/<slug>`. The link is the invite — no accounts, no gatekeeping. Each canvas has two surfaces:
- **Designs** — a bento grid of work that never shipped: images (resized client-side), live HTML demos (sandboxed iframes rendering as their own thumbnails), GitHub repos (+ optional live demo embed), or links. Clicking a card opens a frosted right-side drawer.
- **Ideas** — a free canvas (dot grid). Double-click anywhere to drop a thought; each idea is a draggable cluster (root card + additions with elbow connectors). Hover any card and hit + to pile on inline. The drawer gives the full page view (H1/H2/H3/text/image blocks) and a richer editor.

## How it runs (three modes, one adapter)
The persistence layer is still one adapter: `store` with `list / get / set / mutate` at the top of `app.html`'s script. Mode is detected at load:
1. **Server (`/c/<slug>` URL):** fetch calls to `/api/c/<slug>/…`. This is the primary mode now.
2. **Claude artifact:** `window.storage` with `shared=true` — unchanged from v0.
3. **Bare file:** demo mode (seeded content, banner, nothing saves).

## Backend (server.js)
SQLite, two tables: `canvases(slug, name, created)` and `kv(canvas, key, value, updated)` — the same `design:`/`idea:`/`meta:` keys as v0, namespaced per canvas. API:
- `POST /api/canvases {name}` → `{slug}` — slug is name + 6 random chars (unguessable-ish; the link is the only access control)
- `GET /api/canvases/:slug` — canvas meta
- `GET /api/c/:slug/keys?prefix=` · `GET /api/c/:slug/kv?key=` · `PUT /api/c/:slug/kv {key,value}`
- `POST /api/c/:slug/mutate {key, op}` — **the concurrency fix.** Read-modify-write happens server-side in one transaction. Ops: `appendCard` (pile on), `updateCard` (edit blocks/author/title), `patch` (pos/title). Two people adding to the same idea at the same moment can no longer clobber each other (verified with 6 concurrent appends). Artifact/demo modes fall back to client-side `applyOp` — same function, mirrored in both files.

Limits: keys validated against `^(design|idea|meta):`, values ≤4.5MB (images are ≤3.5MB dataURLs client-side), request bodies ≤6MB.

## Realtime sync (SSE)
`GET /api/c/:slug/events` is a Server-Sent Events stream (25s heartbeat). Every successful write broadcasts `{key, src}` to that canvas's subscribers. The client (server mode only) subscribes on boot, ignores events carrying its own per-tab `src` id, refetches just the changed key and merges it into state. Re-renders are **deferred while the user is mid-composition, mid-drag, or in the drawer** (`dirty` flag) and flushed the moment they're done — verified with two live tabs: posts and pile-ons appear in the other tab in <1s, and an open composer is never clobbered by incoming changes. On stream reconnect the client re-pulls everything. Note: SSE needs a long-running process — deploy to a persistent host (Railway/Fly/VPS), not serverless.

## Directory + team key
The landing page and the ☰ sidebar list **all canvases** (`GET /api/canvases` — name, design/idea counts, last activity, sorted by activity). The trust boundary is the site itself: set the **`TEAM_KEY`** env var and every page/API requires the shared passphrase once per browser (sha256 cookie, 1yr, HttpOnly; timing-safe compares; `Secure` flag added behind HTTPS proxies). Unset `TEAM_KEY` = fully open (local dev). Unlock page: `public/unlock.html`. On Railway: add `TEAM_KEY` in service → Variables.

## Credits (per canvas now)
The hardcoded `TEAM` array is gone from the server path. Credit is an input + datalist: type any name or pick a known one. The pool = `meta:team` key (seeded `[]` on canvas creation, grows when someone posts under a new name) ∪ every author already on the wall. `DEFAULT_TEAM` in app.html only seeds artifact/demo modes. Credit is still optional everywhere — "No credit — post it quietly" is the placeholder.

## Data schema (unchanged from v0)
- `design:<id>` → `{v, kind: 'image'|'proto'|'repo'|'link', data, demo?, caption, author, ts}`
- `idea:<id>` → `{v, title, ts, updated, pos:{x,y}, cards:[{id, parent, ts, author, blocks:[{t,c}]}]}` — root card has `parent: null`; tree derived from parent pointers, so forking is free
- `meta:team` → `["name", …]` per canvas

## Known limits (deliberate for v1)
- **One shared key, not accounts.** Everyone inside the key sees and can edit everything; there are no per-canvas permissions. Rotating the key = changing the env var (everyone re-enters once).
- **No delete, no moderation** — by design, same open-access ethos as v0. Revisit only if abused.
- **`localStorage` recents** on the landing page are per-browser, not synced.
- **Canvas drag on touch** still competes with scroll; desktop-first.
- **Videos** go in as links, not uploads.
- Full-design uploads still use plain `set` (immutable once up, so last-write-wins is irrelevant there).

## Later (phase 2 — unchanged plan)
- Slack ingestion: webhook → worker writing the same `design:`/`idea:` keys into a canvas.
- Social pipeline: export action per design card (image + caption + credit).
- Cross-linking: attach a design to an idea block.
- Public/commons ring: per-canvas visibility flags, report/delete, rate limits — required before opening beyond link-holders.

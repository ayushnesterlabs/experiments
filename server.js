/* =========================================================
   EXPERIMENTS — minimal multi-canvas backend
   Zero dependencies: node:http + node:sqlite (Node 22.5+).
   Run: node server.js   (PORT env to override, default 4321)

   Data model: one SQLite file, two tables.
     canvases(slug, name, created)
     kv(canvas, key, value, updated)   — same design:/idea:/meta: keys as v0

   API (all JSON):
     POST /api/canvases              {name}            → {slug, name}
     GET  /api/canvases/:slug                          → {slug, name, created}
     GET  /api/c/:slug/keys?prefix=  →                 {keys:[...]}
     GET  /api/c/:slug/kv?key=       →                 {value} | 404
     PUT  /api/c/:slug/kv            {key, value}      → {ok}
     POST /api/c/:slug/mutate        {key, op}         → {ok}
       op: {type:'appendCard', card}
           {type:'updateCard', cardId, blocks, author, title?}
           {type:'patch', patch:{pos?, title?}}
       Read-modify-write happens server-side in one transaction,
       so concurrent pile-ons no longer clobber each other.

   Pages:
     /            → public/index.html  (create / open canvases)
     /c/:slug     → public/app.html    (the experiments app)
========================================================= */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 4321;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

const MAX_BODY = 6 * 1024 * 1024;   // JSON body cap
const MAX_VALUE = 4.5 * 1024 * 1024; // per-key value cap (images are ≤3.5MB dataURLs)
const KEY_RE = /^(design|idea|meta):[A-Za-z0-9:._-]{1,80}$/;
const SLUG_RE = /^[a-z0-9-]{3,60}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'experiments.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS canvases(
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS kv(
    canvas TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY(canvas, key));
`);

const q = {
  canvasGet: db.prepare('SELECT slug, name, created FROM canvases WHERE slug = ?'),
  canvasNew: db.prepare('INSERT INTO canvases(slug, name, created) VALUES(?,?,?)'),
  kvKeys:    db.prepare("SELECT key FROM kv WHERE canvas = ? AND key LIKE ? ESCAPE '\\' ORDER BY key"),
  kvGet:     db.prepare('SELECT value FROM kv WHERE canvas = ? AND key = ?'),
  kvSet:     db.prepare(`INSERT INTO kv(canvas, key, value, updated) VALUES(?,?,?,?)
                         ON CONFLICT(canvas, key) DO UPDATE SET value=excluded.value, updated=excluded.updated`),
  counts:    db.prepare(`SELECT substr(key, 1, instr(key, ':') - 1) AS kind, COUNT(*) AS n
                         FROM kv WHERE canvas = ? AND key NOT LIKE 'meta:%' GROUP BY kind`),
};

/* ---------- op application (mirror of the client fallback) ---------- */
function applyOp(obj, op) {
  if (op.type === 'appendCard') {
    if (!op.card || typeof op.card !== 'object') throw new Error('bad card');
    obj.cards = obj.cards || [];
    obj.cards.push(op.card);
    obj.updated = Date.now();
  } else if (op.type === 'updateCard') {
    const c = (obj.cards || []).find(x => x.id === op.cardId);
    if (c) { c.blocks = op.blocks || []; c.author = op.author || ''; }
    if (typeof op.title === 'string') obj.title = op.title;
    obj.updated = Date.now();
  } else if (op.type === 'patch') {
    const p = op.patch || {};
    if (p.pos && typeof p.pos.x === 'number' && typeof p.pos.y === 'number') obj.pos = { x: p.pos.x, y: p.pos.y };
    if (typeof p.title === 'string') obj.title = p.title;
    obj.updated = Date.now();
  } else {
    throw new Error('unknown op');
  }
  return obj;
}

/* ---------- realtime: SSE subscribers per canvas ---------- */
const subs = new Map(); // slug → Set<ServerResponse>
function broadcast(slug, key, src) {
  const set = subs.get(slug);
  if (!set || !set.size) return;
  const msg = `data: ${JSON.stringify({ key, src })}\n\n`;
  for (const res of set) { try { res.write(msg); } catch {} }
}
function subscribe(slug, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  let set = subs.get(slug);
  if (!set) { set = new Set(); subs.set(slug, set); }
  set.add(res);
  const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ka); set.delete(res); if (!set.size) subs.delete(slug); });
}

/* ---------- helpers ---------- */
const slugify = s => String(s).toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'canvas';
const rand = n => crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, n);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const pages = {};
function page(res, file) {
  if (!pages[file] || process.env.NODE_ENV !== 'production') {
    pages[file] = fs.readFileSync(path.join(PUBLIC, file));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(pages[file]);
}

/* ---------- router ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  /* pages */
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page(res, 'index.html');
  const pageMatch = p.match(/^\/c\/([a-z0-9-]+)\/?$/);
  if (req.method === 'GET' && pageMatch) return page(res, 'app.html');
  if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  /* canvas registry */
  if (p === '/api/canvases' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return json(res, 400, { error: 'name required' });
    const slug = `${slugify(name)}-${rand(6)}`;
    q.canvasNew.run(slug, name, Date.now());
    q.kvSet.run(slug, 'meta:team', '[]', Date.now());
    return json(res, 200, { slug, name });
  }
  const metaMatch = p.match(/^\/api\/canvases\/([a-z0-9-]+)$/);
  if (metaMatch && req.method === 'GET') {
    const row = q.canvasGet.get(metaMatch[1]);
    if (!row) return json(res, 404, { error: 'not found' });
    const counts = Object.fromEntries(q.counts.all(row.slug).map(r => [r.kind, r.n]));
    return json(res, 200, { ...row, designs: counts.design || 0, ideas: counts.idea || 0 });
  }

  /* per-canvas KV */
  const kvMatch = p.match(/^\/api\/c\/([a-z0-9-]+)\/(keys|kv|mutate|events)$/);
  if (kvMatch) {
    const [, slug, action] = kvMatch;
    if (!SLUG_RE.test(slug) || !q.canvasGet.get(slug)) return json(res, 404, { error: 'no such canvas' });
    const src = url.searchParams.get('src') || '';

    if (action === 'events' && req.method === 'GET') return subscribe(slug, req, res);

    if (action === 'keys' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      const like = prefix.replace(/[%_\\]/g, c => '\\' + c) + '%';
      return json(res, 200, { keys: q.kvKeys.all(slug, like).map(r => r.key) });
    }

    if (action === 'kv' && req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      if (!KEY_RE.test(key)) return json(res, 400, { error: 'bad key' });
      const row = q.kvGet.get(slug, key);
      return row ? json(res, 200, { value: row.value }) : json(res, 404, { error: 'not found' });
    }

    if (action === 'kv' && req.method === 'PUT') {
      const body = await readBody(req);
      const { key, value } = body;
      if (!KEY_RE.test(String(key))) return json(res, 400, { error: 'bad key' });
      if (typeof value !== 'string' || value.length > MAX_VALUE) return json(res, 400, { error: 'bad value' });
      try { JSON.parse(value); } catch { return json(res, 400, { error: 'value must be JSON' }); }
      q.kvSet.run(slug, key, value, Date.now());
      broadcast(slug, key, src);
      return json(res, 200, { ok: true });
    }

    if (action === 'mutate' && req.method === 'POST') {
      const body = await readBody(req);
      const { key, op } = body;
      if (!KEY_RE.test(String(key))) return json(res, 400, { error: 'bad key' });
      if (!op || typeof op !== 'object') return json(res, 400, { error: 'op required' });
      try {
        db.exec('BEGIN IMMEDIATE');
        const row = q.kvGet.get(slug, key);
        if (!row) { db.exec('ROLLBACK'); return json(res, 404, { error: 'not found' }); }
        const obj = applyOp(JSON.parse(row.value), op);
        const value = JSON.stringify(obj);
        if (value.length > MAX_VALUE) { db.exec('ROLLBACK'); return json(res, 400, { error: 'too large' }); }
        q.kvSet.run(slug, key, value, Date.now());
        db.exec('COMMIT');
        broadcast(slug, key, src);
        return json(res, 200, { ok: true });
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        return json(res, 400, { error: e.message });
      }
    }
  }

  json(res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    const code = e.code === 413 ? 413 : e.code === 400 ? 400 : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) json(res, code, { error: e.message || 'server error' });
  });
}).listen(PORT, () => {
  console.log(`Experiments running → http://localhost:${PORT}`);
});

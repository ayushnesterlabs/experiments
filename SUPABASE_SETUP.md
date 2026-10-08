# Supabase setup — make the live site fully functional

The app (static, hosted on Vercel) talks to Supabase directly from the browser:
Postgres for data, Storage for images, Realtime for live cross-tab sync, and
anonymous Auth so anyone with the link just works (no passphrase). No
server/Edge Functions needed.

Do these **four steps once**, then every `git push` to `main` deploys a fully
working site. The project URL is already filled into `public/config.js`.

---

## 1. Create the tables, security rules, and realtime
Open **SQL Editor** → **New query**, paste all of this, and **Run**:

```sql
-- Canvases directory ------------------------------------------------------
create table if not exists public.canvases (
  slug    text primary key,
  name    text not null,
  created bigint not null,
  updated bigint not null,
  designs int not null default 0,
  ideas   int not null default 0
);

-- Per-canvas key/value items: design:<id>, idea:<id>, meta:team -----------
create table if not exists public.items (
  canvas text not null references public.canvases(slug) on delete cascade,
  key    text not null,
  json   text not null,
  ts     bigint not null,
  primary key (canvas, key)
);
create index if not exists items_canvas_idx on public.items(canvas);

-- Row-Level Security: any signed-in user (anonymous visitors included) ----
alter table public.canvases enable row level security;
alter table public.items    enable row level security;

create policy "team access canvases" on public.canvases
  for all to authenticated using (true) with check (true);
create policy "team access items" on public.items
  for all to authenticated using (true) with check (true);

-- Realtime: stream item changes so edits show up live in other tabs -------
alter publication supabase_realtime add table public.items;
```

## 2. Create the image bucket
**Storage** → **New bucket** → name it exactly `images`, toggle **Public
bucket** ON, create it. Then back in **SQL Editor**, run:

```sql
create policy "team upload images" on storage.objects
  for insert to authenticated with check (bucket_id = 'images');
create policy "public read images" on storage.objects
  for select to public using (bucket_id = 'images');
```

## 3. Enable anonymous sign-ins
**Authentication** → **Sign In / Providers** → turn **Anonymous sign-ins** ON.
(This is how open access works — every visitor gets a throwaway signed-in
session, which is what the RLS policies above require.)

## 4. Fill in the anon key in `public/config.js`
**Project Settings** → **API** → copy the **anon public** key into
`public/config.js`:

```js
window.SUPABASE_CONFIG = {
  url: 'https://mcrbikbarcbssgfuqrot.supabase.co',   // already set
  anonKey: 'eyJhbGc...the anon public key...'
};
```

Both values are **safe to commit** — the anon key is meant for browsers; RLS is
what actually governs the data.

---

## Go live
```
git add public/config.js && git commit -m "Wire up Supabase" && git push
```
Vercel redeploys in ~1 min. Open the site and create a canvas — images, ideas,
designs, the directory, and live cross-tab sync all work, no login.

## Notes
- **Demo mode:** with `anonKey` left `null`, the site still deploys and renders
  but saves nothing — useful for a quick preview before step 4.
- **Want a shared-key gate instead of fully open?** Ask and I'll re-add the
  unlock page (a shared account whose password is the team key).
- **Counters** (`X designs · Y ideas`) are best-effort; data itself is never lost
  (concurrent pile-ons use a compare-and-swap retry).

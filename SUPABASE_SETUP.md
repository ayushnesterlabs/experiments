# Supabase setup — make the live site fully functional

The app (static, hosted on Vercel) talks to Supabase directly from the browser:
Postgres for data, Storage for images, Auth for the shared team-key gate, and
Realtime for live sync across tabs. No server/Edge Functions needed.

Do these **five steps once**, then every `git push` to `main` deploys a fully
working site.

---

## 1. Create a Supabase project
<https://supabase.com> → **New project**. Pick a name, a strong DB password
(you won't need it again), and a region close to your team. Wait for it to
finish provisioning.

## 2. Create the tables, security rules, and realtime
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

-- Row-Level Security: only signed-in users (= anyone who knows the team key)
alter table public.canvases enable row level security;
alter table public.items    enable row level security;

create policy "team access canvases" on public.canvases
  for all to authenticated using (true) with check (true);
create policy "team access items" on public.items
  for all to authenticated using (true) with check (true);

-- Realtime: stream item changes so edits show up live in other tabs -------
alter publication supabase_realtime add table public.items;
```

## 3. Create the image bucket
**Storage** → **New bucket** → name it exactly `images`, toggle **Public
bucket** ON, create it. Then back in **SQL Editor**, run:

```sql
create policy "team upload images" on storage.objects
  for insert to authenticated with check (bucket_id = 'images');
create policy "public read images" on storage.objects
  for select to public using (bucket_id = 'images');
```

## 4. Create the shared team account (this IS the team key)
Everyone signs in as one shared account; its **password** is the team key people
type on the unlock page.

**Authentication** → **Users** → **Add user** → **Create new user**:
- **Email:** `team@experiments.app` (doesn't need to be real — it just has to
  match `teamEmail` in `public/config.js`)
- **Password:** the team key you'll share with the team
- **Auto Confirm User:** ON

> Rotate the key later by changing this user's password here.

## 5. Fill in `public/config.js`
**Project Settings** → **API**. Copy **Project URL** and the **anon public** key
into `public/config.js`:

```js
window.SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'eyJhbGc...the anon public key...',
  teamEmail: 'team@experiments.app'   // must match the user from step 4
};
```

Both values are **safe to commit** — the anon key is meant for browsers; RLS +
the team account are what actually protect the data.

---

## Go live
```
git add public/config.js && git commit -m "Wire up Supabase" && git push
```
Vercel redeploys in ~1 min. Open the site, enter the team key once, and create a
canvas. Images, ideas, designs, the directory, and live cross-tab sync all work.

## Notes
- **Demo mode:** with `url`/`anonKey` left `null`, the site still deploys and
  renders but saves nothing — useful for a quick preview before step 5.
- **Fully open (no key):** if you ever want no gate, enable Anonymous sign-ins in
  Supabase Auth and auto-sign-in instead of the unlock page — ask and I'll wire it.
- **Counters** (`X designs · Y ideas`) are best-effort; data itself is never lost
  (concurrent pile-ons use a compare-and-swap retry).

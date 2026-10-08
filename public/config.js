/* Supabase config — the public project URL + anon key. Both are safe to ship
   to the browser (that's what the anon key is for); access is governed by
   Postgres Row-Level Security.

   Fill these in from your Supabase project:
     Project Settings → API → Project URL        -> url
     Project Settings → API → Project API keys   -> anonKey  (the "anon public" one)

   Access is open: each visitor is signed in anonymously (enable Anonymous
   sign-ins in Supabase → Authentication → Sign In / Providers).

   Leave url/anonKey null to run the pages in offline demo mode. */
window.SUPABASE_CONFIG = {
  url: 'https://mcrbikbarcbssgfuqrot.supabase.co',
  anonKey: null   // Project Settings → API → "anon public" key
};

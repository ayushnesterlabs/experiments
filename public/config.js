/* Supabase config — the public project URL + anon key. Both are safe to ship
   to the browser (that's what the anon key is for); real access control lives
   in Postgres Row-Level Security + the shared team account below.

   Fill these in from your Supabase project:
     Project Settings → API → Project URL        -> url
     Project Settings → API → Project API keys   -> anonKey  (the "anon public" one)

   teamEmail is the single shared account everyone signs in as; the "team key"
   on the unlock page IS that account's password. Rotate the key by changing
   that user's password in Supabase → Authentication → Users.

   Leave url/anonKey null to run the pages in offline demo mode. */
window.SUPABASE_CONFIG = {
  url: null,
  anonKey: null,
  teamEmail: 'team@experiments.app'
};

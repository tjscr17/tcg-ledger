# The Ledger — One Piece TCG Collection Tracker

A web app for tracking your One Piece TCG collection with daily TCGPlayer market prices and a card catalog from [OPTCGAPI](https://optcgapi.com). Search ~4,000+ cards across all sets, log who paid what, and watch your portfolio value move.

## Two ways to run it

**Solo mode** (default) — Works immediately. Data lives in your browser's localStorage. Good for trying it out or single-person use. Not shared between people or devices.

**Shared mode** — Adds three env vars and runs on a free Supabase backend. Everyone with the URL sees the same vaults, and changes sync in real time. This is what you want for you-and-your-friends use.

---

## Quick start (solo mode — 2 minutes)

```bash
npm install
npm run dev
```

Open http://localhost:5173. That's it. You can deploy this as-is and use it yourself, but each person who visits gets their own private data.

---

## Going shared — full setup (15 minutes)

### Step 1: Set up Supabase (free)

1. Go to [supabase.com](https://supabase.com) and create a free account.
2. Create a new project. Note the **Project URL** and **anon/public API key** from Settings → API.
3. In the SQL Editor, run this:

```sql
create table collections (
  id uuid primary key default gen_random_uuid(),
  vault_key text not null,
  name text not null,
  created_at timestamptz default now()
);

create table entries (
  id uuid primary key default gen_random_uuid(),
  vault_key text not null,
  collection_id uuid references collections(id) on delete cascade,
  card_id text not null,
  condition text,
  purchase_price numeric default 0,
  owner_name text,
  contributions jsonb default '[]',
  notes text,
  added_at timestamptz default now()
);

create index on collections (vault_key);
create index on entries (vault_key);

alter publication supabase_realtime add table collections;
alter publication supabase_realtime add table entries;

alter table collections enable row level security;
alter table entries enable row level security;

create policy "vault read"   on collections for select using (true);
create policy "vault write"  on collections for all    using (true);
create policy "vault read e"  on entries     for select using (true);
create policy "vault write e" on entries     for all    using (true);
```

> The RLS policies are permissive — anyone with the anon key can read/write. Because this app uses a `vault_key` partition you choose, your data is hidden from anyone who doesn't know your key, but a sophisticated user could enumerate keys. For a friend group this is fine; if you want stricter security later, swap in proper auth.

### Step 2: Deploy to Vercel (free)

1. Push this project to a GitHub repo.
2. Go to [vercel.com](https://vercel.com), sign in with GitHub, and import the repo.
3. Vercel auto-detects Vite. Before deploying, add these **Environment Variables**:

   | Key | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://yourproject.supabase.co` |
   | `VITE_SUPABASE_KEY` | your anon public key |
   | `VITE_VAULT_KEY` | any string you and your friends agree on (e.g. `strawhat-crew-2026`) |

4. Hit Deploy. You get a URL like `https://your-app.vercel.app`.
5. Share that URL with your friends. As long as everyone visits the same deployment, they see the same vaults.

### Alternative: Netlify

Same flow as Vercel — connect repo, set the three env vars, deploy. Both are free for personal use.

---

## How `VITE_VAULT_KEY` works

Think of it as the "name of your friend group's shared notebook." Everyone using the same deployment automatically uses the same key, so they all see the same data. If you want separate groups with separate data, deploy twice with different keys.

If you ever want to change keys (start fresh), update the env var, redeploy, and the old data is still in Supabase under the old key — you can swap back any time.

---

## Project structure

```
src/
  App.jsx        Main app + all views
  storage.js     Storage adapter (localStorage in solo, Supabase in shared)
  catalog.js     Card catalog + price history from OPTCGAPI
  pricing.js     TCGCSV pricing client (raw market prices + variant resolver)
  psa.js         PSA cert lookup client (used by "Add by cert")
  migrate.js     One-time client-side migrations (canonical id rewrite, etc.)
  styles.css     All styles
  main.jsx       React entry point

api/
  tcgcsv.js      Vercel function: TCGCSV proxy (price lookup + variant search)
  psa.js         Vercel function: PSA cert proxy (PSA blocks browser CORS)
```

## Data sources

- **Card catalog**: [OPTCGAPI](https://optcgapi.com) by DomoSlime — free, no auth, refreshed daily. Catalog is cached in your browser for 24 hours.
- **Card images**: OPTCGAPI's CDN where available; falls back to the TCGPlayer product CDN once a card has been resolved to a TCGPlayer printing.
- **Market prices**: [TCGCSV](https://tcgcsv.com) — daily TCGPlayer dumps, free, no auth. Routed through `/api/tcgcsv` which caches the productId↔group index and per-group prices on the function instance.
- **PSA certs** (optional): the official PSA public API, proxied through `/api/psa` to dodge CORS. Set `VITE_PSA_TOKEN` to enable the "Add by cert" flow.

If OPTCGAPI is ever down, the cached catalog keeps working. If TCGCSV is down, prices fall back to whatever's still cached locally (snapshots TTL 6h).

## License & credits

One Piece and the One Piece Trading Card Game are trademarks of Eiichiro Oda, Bandai, Shonen Jump, and Viz Media. Please support the official release.

Card data via [OPTCGAPI](https://optcgapi.com) (free, community-run). Pricing via [TCGCSV](https://tcgcsv.com) (free; please set a polite User-Agent if you self-host the proxy).

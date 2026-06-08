# OPTCG Ledger — 130point sync (Chrome extension)

Syncs One Piece TCG sold-listing data from **130point.com** into your
OPTCG Ledger Supabase project. Runs in your browser so it uses your own
Cloudflare clearance — no proxies, no scraping infrastructure required.

## How it works

1. You install the extension (unpacked).
2. You paste your Supabase URL, anon key, and `VITE_VAULT_KEY` once.
3. You click **Sync from 130point**.
4. The background service worker:
   - Reads every entry in your collection from Supabase.
   - Deduplicates by displayId (e.g. all your `OP01-016` variants → one query).
   - For each unique displayId, queries
     `https://130point.com/api/search/html?q={ID}+one+piece&sort=recent&mp=all`
     from your browser session (so the request carries your cookies,
     including the Cloudflare `cf_clearance` token).
   - Parses the HTML response with `parser.js`.
   - For every result whose title matches that displayId, builds a normalized
     row and upserts it into `sales`.
5. Your webapp's existing realtime subscription on the `sales` table picks
   up the new rows and the graded-price estimator on the Collection view
   uses them on the next Refresh.

Politeness: a 1.2 s delay between queries so we look like a person clicking
through pages, not a script. On a ~34-card collection that's ~45 s total.

## One-time setup

### 1. Add the unique constraint to the `sales` table

The extension upserts on `(vault_key, listing_url)` so re-syncing the same
query doesn't write duplicate rows. Run this once in the Supabase SQL editor:

```sql
alter table sales
  add constraint sales_vault_key_listing_url_unique
  unique (vault_key, listing_url);
notify pgrst, 'reload schema';
```

If you haven't created the `sales` table yet, do that first — the migration
SQL is at the top of `src/storage.js`.

### 2. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Pick the `extension/` folder in this repo.
5. Pin the extension to the toolbar (click the puzzle icon → pin).

### 3. Configure

1. Click the extension icon — popup appears.
2. Fill in:
   - **Project URL** — your Supabase project URL
     (e.g. `https://xxxxxxxx.supabase.co`).
   - **Anon key** — the same `VITE_SUPABASE_KEY` your webapp uses.
   - **Vault key** — the same `VITE_VAULT_KEY` your webapp uses.
3. Click **Save settings**.

### 4. Warm Cloudflare clearance

Before your first sync, open **[https://130point.com/search](https://130point.com/search)**
in another tab and let it load. This gives Chrome a fresh `cf_clearance`
cookie that the extension will reuse. You only need to do this once per
day (sometimes longer — until Cloudflare invalidates).

### 5. Sync

Click **Sync from 130point**. The popup shows live progress
(`Synced 7/34 cards · 23 sales inserted · current: OP01-016`). After it
finishes, open your webapp, go to the Collection tab, and click
**Refresh graded prices** — entries with matching sales will get their
graded_price updated.

## What gets inserted vs skipped

| Title pattern | Decision |
|---|---|
| 1 OP card-ID in title, currency=USD | Insert |
| 2+ OP card-IDs (set bundle, e.g. `EB02-061 OP11-118 OP01-016 Set`) | **Skip** — bundle prices aren't useful for single-card estimation |
| 0 OP card-IDs | Skip |
| Non-USD currency (e.g. AUD, EUR) | **Skip** — no FX conversion yet |
| No sale date | Skip |
| Title doesn't match the queried displayId | Skip — false-positive search hit |

Each row is tagged `source = '130point-scrape'` so the webapp knows where it
came from. Manual entries (`source = 'manual'`) are never overwritten by
sync — the upsert dedups on `listing_url`, which manual rows don't have.

## Updating the parser

130point's HTML structure could shift; if so, sync will silently insert 0
rows. To diagnose:

1. `chrome://extensions` → OPTCG Ledger sync → **service worker** →
   click **Inspect**. That opens DevTools attached to the background worker.
2. Click Sync from the popup.
3. The worker's console shows fetch URLs, parse failures, and Supabase errors.

If the layout changed, edit `parser.js` — the selectors are concentrated in
`parseSearchResultsHtml`. Reload the extension (`chrome://extensions` →
↻ icon) to pick up changes.

## Future work

- **Bulk-pull mode** — instead of one query per owned card, query
  `q=one+piece+tcg` paginated. Would slurp 5k+ sales and populate the
  table with data for cards you don't own yet (useful for rarity-tier
  multipliers and trend analysis). Adds ~5-15 minutes per sync.
- **Currency conversion** — non-USD sales are currently dropped. We could
  convert at sale_date's historical FX rate so AUD/EUR sales feed the
  estimator.
- **Additional sources** — Whatnot ended-auctions, TCGPlayer marketplace,
  etc. Each becomes a sibling parser; the orchestrator is the same.

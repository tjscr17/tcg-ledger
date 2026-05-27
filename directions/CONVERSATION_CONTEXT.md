# Conversation Context — OP TCG Pricing Platform Architecture

This document captures the architectural thinking and decisions from a planning conversation. It's intended as input for Claude Code to use when generating a proper `CLAUDE.md` based on the actual codebase.

---

## Project Vision

A personal platform for tracking a One Piece TCG collection (shared between two users), expanding into:

1. **Collection value tracking** — current state (already built).
2. **Listing alerts** across markets — notify when watched cards are listed below fair value.
3. **Proprietary fair value model** — based on recent sales, with regression-based projection for illiquid cards.
4. **Grade-specific pricing** — separate layers for raw, PSA, BGS, CGC.

## Current State (as of this conversation)

- Site is built on Supabase + Vercel + Python.
- OPTCG API used for card metadata.
- PriceCharting API used for price data — but catalogs don't join cleanly. Being phased out.
- Goal is to track **all** OP TCG cards (~8–10k unique printings across EN + JP including parallels, alt arts, manga, SPs, promos).

## Data Source Strategy

### Decisions made

- **OPTCG API** is the canonical source for card identity (set codes, card numbers, rarity, language).
- **PriceCharting is being dropped** — poor catalog alignment with OPTCG, weak OP TCG coverage.
- **TCGCSV** (daily TCGPlayer dumps as free CSVs) is the leading candidate replacement for baseline pricing. Evaluate join rate against OPTCG before committing.

### Long-term layered architecture

| Layer | Source | Purpose |
|-------|--------|---------|
| Catalog + baseline price | TCGCSV | Daily market price for every card |
| Live listings (alerts) | TCGPlayer scraper (Playwright) | Targeted to watchlist cards, not full catalog |
| Sold data (fair value truth) | eBay Browse + Marketplace Insights APIs | Real transactions for the fair value model |
| EU prices | Cardmarket API | Real API, needs registration |
| JP prices (Phase 2+) | Yuyu-tei, Cardrush, Snkrdunk | All scraping, no clean APIs |

### Why not just stick with TCGCSV long-term

- No individual listings → can't do underpriced alerts.
- No sold data → fair value model wants real transactions, not smoothed market price estimates.
- Daily granularity → too slow during set release weeks or meta shifts.
- Single point of failure → it's a third-party rehost of TCGPlayer data and could go down.

It's the right starting point, just not the endpoint.

## Schema Principles

### Card identity

All cards keyed by internal `card_id` (UUID). External IDs live in a `card_mappings` table.

Identity components:
- `set_code` + `card_number` + `rarity`
- `variant` (base, manga, parallel, alt art, SP, SEC) — **separate `card_id`s, not attributes**
- `language` (EN / JP)

So OP05-069 Yamato exists as 4+ distinct `card_id`s: base, parallel, manga, SEC alt.

### Core tables

- `cards` — canonical catalog, one row per unique printing
- `sets` — set metadata
- `card_mappings` — `card_id` ↔ external IDs (tcgplayer_id, pricecharting_id, etc.)
- `holdings` — `(user_id, card_id, grade, quantity, acquired_at, acquired_price)`
- `current_prices` — one row per `(card_id, grade, source)`, upserted; powers the collection tracker
- `price_history` — append-only time series: `(card_id, grade, source, recorded_at, price, volume)`
- `listings` — scraped live listings (Phase 3)
- `sales` — sold transactions, sacred and append-only (Phase 4 input)
- `fair_values` — `(card_id, grade, value, confidence, method, computed_at)` (Phase 4 output)
- `scrape_log` / `events` — observability for scrapers and matchers

### Hard rules

- **Never compute current value into `holdings`** — always join to `current_prices` on read.
- **`sales` and `price_history` are append-only** — never overwrite, never delete.
- **Keep `raw_json` on scraped data** — fields you didn't parse become fields you need.
- **RLS from day one** on user-scoped tables (`holdings` especially).
- **Daily backups to S3/B2** — historical price data is irreplaceable; can't backfill.

### Storage scale notes

- Postgres handles this fine until ~100M rows in `price_history`. At 10k cards × daily × few sources × 5 years = ~50M rows. Plenty of headroom.
- Migrate to TimescaleDB (Postgres extension) only if/when pulling hourly data across many sources.
- Supabase free tier (500MB) will be outgrown within ~a year of history. Pro tier ($25/mo, 8GB) is the natural step.

## Matching Layer (the hardest part)

The OPTCG ↔ marketplace mapping is the highest-leverage code in the project. Get it right once; every future set release benefits.

### Pipeline

1. Normalize names on both sides (lowercase, strip punctuation, expand variant tokens: "Alt Art" / "AA" / "Parallel" / "Manga" / "SP" / "SEC").
2. Composite-key match: `set_code + card_number + variant + language`.
3. Fuzzy-name fallback for ambiguous cases (rapidfuzz).
4. Output three buckets:
   - **Auto-matched** (≥0.9 confidence)
   - **Needs review** (0.7–0.9)
   - **Unmatched** (<0.7)
5. Admin review queue UI for human disambiguation — shows top 3 candidates per unmatched, one-click confirm.

### Variant pain points

- Manga rares (sometimes labeled "Manga Art", sometimes embedded in name)
- Alt arts vs parallels vs SPs — TCGPlayer sometimes conflates
- Promo printings (Winner promos, Online Regional, etc.)
- Japanese reprints with same card number but different art

Bake variant detection into the normalizer.

## Fair Value Model (Phase 4)

### Two-tier approach

**Liquid cards (≥5 sales in trailing 14 days):**
- Trimmed mean or median of sold prices.
- Recency-weighted.
- IQR or z-score outlier filter.

**Illiquid cards:**
- Regression against a comparable-basket index.
- Pick 10–20 cards that historically move together (same set, similar rarity tier, similar playability).
- Build an index from the basket.
- Project thin card based on last known sale × index movement since.
- Conceptually similar to how thinly-traded equities are marked.

### Grade premiums (Phase 5)

- `graded_price = raw_price × grade_multiplier × scarcity_factor`
- Multipliers aren't constant; they vary by card scarcity and pop report.
- `scarcity_factor` from PSA/BGS/CGC pop-in-grade-or-higher.
- PSA has a public lookup; BGS and CGC are messier.

## Conventions

### Stack (confirm against actual repo)

- Frontend & hosting: Vercel
- DB: Supabase (Postgres)
- Backend / scrapers / ETL: Python
- Auth: Supabase Auth + RLS

### Scrapers

- Playwright, not raw requests, for rendered pages.
- All scrapers log to `scrape_log` with timestamp, source, status, error context.
- Run on a VPS or scheduled GitHub Actions — not Supabase Edge Functions (Playwright doesn't fit there).
- Respect rate limits; rotate user agents; consider residential proxy if blocked.

### Migrations

- Through Supabase migrations, not ad-hoc SQL.
- New variant types or grade types: update canonical enum + backfill mappings.

## Phased Roadmap

### Phase 1 — Fix price data foundation (current)
Replace PriceCharting with TCGCSV. Build the matcher pipeline + review queue.
Exit: ≥95% of cards have a confirmed mapping and a current price.

### Phase 2 — Historical price capture
`price_history` table + daily snapshots + backups + simple history charts.
Exit: 30+ days of reliable daily snapshots, backups verified.

### Phase 3 — Listing scrapers & alerts
eBay Browse API + targeted TCGPlayer scraper. Alert rules + notifications.
Exit: Alerts firing reliably on watchlist across both sources.

### Phase 4 — Fair value model
eBay Marketplace Insights → `sales`. Liquid + illiquid models. `fair_values` table.
Exit: Fair values published with confidence scores; backtest shows reasonable illiquid accuracy.

### Phase 5 — Grade premiums
PSA/BGS/CGC pop integration. Multiplier model. Track drift.
Exit: Graded fair values with pop-aware scarcity adjustments.

### Later
- JP market (Yuyu-tei, Cardrush, Snkrdunk)
- Cardmarket EU
- Whatnot live break pricing
- Portfolio analytics: P&L attribution, set-level performance, grade arbitrage

## Don't Do

- Don't try to manually map cards at scale — build the matcher.
- Don't cache current value into holdings — join on read.
- Don't overwrite `sales` or `price_history`.
- Don't run Playwright on Supabase Edge Functions.
- Don't trust spot prices for fair value — use sold data.
- Don't block English tracking on JP scrapers.
- Don't skip backups of `price_history` and `sales`.

## Open Questions

- Scraper hosting: VPS vs scheduled GitHub Actions?
- Notification channel: email / Telegram / Discord?
- JP coverage scope?
- When to move Supabase free → Pro?

---

## Instructions for Claude Code

After reading this document and the existing codebase:

1. Generate a `CLAUDE.md` at the repo root that reflects:
   - What's actually in the codebase (real schema, real stack, real conventions).
   - The architectural direction from this context doc where it doesn't conflict with reality.
   - Honest current-state notes (what's built vs aspirational).

2. Generate a `PLANNING.md` at the repo root that:
   - Marks accurately what's done vs what's not.
   - Preserves the phased roadmap above.
   - Has a Decisions Log section with real dates backfilled where known.

3. Where this context doc and the actual code disagree, **trust the code**. Flag the discrepancies in your output so the user can decide which to keep.

4. Don't invent schema details that aren't in the codebase. If something here describes a future state, label it as future in `PLANNING.md`, not as current in `CLAUDE.md`.

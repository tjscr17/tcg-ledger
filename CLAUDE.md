# CLAUDE.md

Working notes for Claude Code on this repo. Reflects the codebase as of
**2026-06-28**, after the 2026-06-22/23 cutover to a normalized Supabase
schema with UUID card identity and a Supabase-sourced catalog.

> Companion docs: [`STATUS.md`](STATUS.md) is the machine-setup + connection
> handoff (env vars, vault keys, project id). [`PLANNING.md`](PLANNING.md) is
> the roadmap + decisions log. `directions/CONVERSATION_CONTEXT.md` is the
> long-form product vision (aspirational, not current state). **Trust this
> file + the code over CONVERSATION_CONTEXT.md.**

---

## What this app is

A two-mode web app for tracking a trading-card collection (One Piece TCG
today; the schema is now multi-TCG — see below):

- **Solo mode** (default) — browser-only, `localStorage`, no backend.
- **Shared mode** — same UI, persisted to a **normalized Supabase Postgres**
  schema, multi-user via a shared `VITE_VAULT_KEY` secret. No Supabase Auth;
  permissive RLS; "knows the vault key" is the entire access boundary.

It is a collection ledger with cost-basis tracking, fund-accounting equity
math, manual + scraped graded-sales data, and PSA cert ingestion. **There is
no live price feed right now** — owned-card market value falls back to cost
basis (see Pricing).

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite 5, plain JSX, no TypeScript |
| Structure | `src/App.jsx` is a ~5k-line monolith — all views, modals, and the equity engine live here by design. Add new views/modals inline. |
| Styles | `src/styles.css` — single hand-written file, BEM-ish `op-*` classes |
| Icons | `lucide-react` |
| State | React hooks only. Per-component `useState`/`useMemo`; `useStoredState` persists filter UI to localStorage. A `variantRev` counter bumps to recompute derived memos. |
| Storage adapter | `src/storage.js` — uniform `store` interface (`list/insert/update/remove/removeWhere/subscribe`) over either localStorage (solo) or Supabase (shared). |
| DB (shared) | Supabase Postgres, **normalized relational schema** (see Data model). |
| Realtime (shared) | Supabase Realtime channel per physical table. |
| Catalog | `src/catalog.js` — read-only Supabase client (hardcoded project, NOT from `VITE_*`) loading the `cards` table. |
| Hosting | Vercel. `api/*.js` are serverless functions; `vite.config.js` mirrors them in dev. |
| Serverless fns | `api/psa.js` (PSA cert proxy), `api/psa-apr.js` (PSA Auction Prices Realized proxy), `api/tcgcsv.js` (TCGplayer lookup, used only by add-from-alternate-source), `api/img.js` (card-art proxy for Bandai CDN). |
| Companion | `extension/` — MV3 Chrome extension syncing 130point.com sold listings into the `sales` table from inside the user's own browser tab. |

---

## Data model (the important part)

### Two layers: logical (app) vs physical (DB)

The app code thinks in **logical tables** (`entries`, `transactions`, `sales`,
`collections`, `watchlist`, `card_aliases`). `src/storage.js` **translates**
these onto the normalized physical schema. Always go through `store`; never
hit Supabase directly for app data (the catalog client in `catalog.js` is the
one exception — it's read-only catalog data, not vault state).

Logical → physical mapping (`PHYS` + the `*PatchToDb` / `*ToApp` converters in
`storage.js`):

| Logical | Physical table | Notable field translations |
|---|---|---|
| `entries` | `collected_cards` | `purchase_price`→`price_paid`, `notes`→`acquisition_notes`, `acquired_at`→`date_acquired`; grading fields collapse to `grade_code`; contributions live on the card's **buy transaction**, not on the card row |
| `transactions` | `transactions` (+ `transaction_contributions`) | `entry_id`→`collected_card_id`; `contributions[]` ⇄ child rows in `transaction_contributions` |
| `sales` | `sales` | no `vault_key` — partitions on **`ingested_by_vault`**; `marketplace`→`listing_site`, `notes`→`description`; grading fields ⇄ `grade_code` |
| `collections` | `collections` | passthrough (+ `tcg_code`, `members` jsonb) |
| `watchlist` | `watchlist` | passthrough |
| `card_aliases` | `card_aliases` | passthrough |

`grade_code` is the single source of grading truth in the DB.
`gradeToCode()` / `codeToGrade()` map between it and the app's
`(grading_company, grade, bgs_black)` triple. Special codes:
`BGS 10 Black Label`, `CGC 10 Pristine`, `RAW`.

### Physical schema (Supabase project `ajpxzfhmyzzgarewijnr`)

Catalog (world-readable, no `vault_key`):

- **`tcgs`** — PK `tcg_code` (text, e.g. `OP`, `PKMN`). `name`, `creator`,
  `source_url`, `source_kind`, `date_added`. **2 rows today: `OP` (One Piece,
  295 sets / 4,575 cards) and `PKMN` (Pokémon — a stub: 0 sets, 0 cards).**
- **`sets`** — PK `id` (uuid). `set_code`, `tcg_code`→`tcgs`, `name`,
  `release_date`, `language` (default `EN`), `source_ref`. 295 rows.
- **`cards`** — PK `id` (uuid) = **the card identity**. `card_code`
  (e.g. `OP06-022`), `variant_key` (`base`/`p1`/`p2`/`r1`…), `name`,
  `rarity`, `category`, `image_url`, `traits` jsonb, `external_id`,
  `source` (`bandai-official` | `tcgplayer` | …), `set_id`→`sets`. 4,575 rows.
- **`grades`** — PK `grade_code`. `company`, `company_nickname`,
  `grade_value`, `description`. 59 rows (full PSA/BGS/CGC scale + RAW).

Vault-scoped (partitioned by `vault_key`, except `sales`):

- **`collections`** — `vault_key`, `name`, `tcg_code`→`tcgs`, `members` jsonb.
- **`collected_cards`** — one row per physical copy. `vault_key`,
  `collection_id`, `card_id`→`cards` (uuid, required), `card_code`
  (**trigger auto-fills** from `cards` on insert — the app only writes
  `card_id`), `grade_code`→`grades`, `cert_number`, `condition`,
  `owner_name`, `price_paid`, `acquisition_notes`, `date_acquired`,
  `date_sold`, `sold_price`, `graded_price`(+`_source`/`_fetched_at`),
  `grade_description`, `psa_spec_id`.
- **`transactions`** — `vault_key`, `collection_id`, `collected_card_id`,
  `card_id`, `card_code` (trigger-filled), `card_display_name`, `type`
  (`buy`/`sell`/`transfer`/`expense`/`payout`; trade legs use these too),
  `amount`, `occurred_at`, `notes`, plus DB-maintained `contrib_total` /
  `is_balanced`.
- **`transaction_contributions`** — `vault_key`, `transaction_id` (FK,
  `ON DELETE CASCADE`), `member_name`, `amount`. Who-paid-what.
- **`sales`** — observed-market sales (NOT the user's own sells). Partitions
  on `ingested_by_vault`. `card_id`→`cards` (nullable), `card_code`,
  `grade_code`, `listing_site`, `listing_url`, `listing_title`, `sale_date`,
  `sale_price`, `currency`, `sale_type`, `num_bids`, `description`, `source`
  (`manual` | `130point-scrape` | …). 3,748 rows.
- **`watchlist`**, **`card_aliases`** — note their `card_id` is **text**
  here (legacy), both currently empty.

All tables have RLS enabled with permissive `using (true)` policies.

> `card_resolutions` is **retired** in the UUID era — there is no per-card
> resolve step. `storage.js`'s resolution helpers are no-ops; `pricing.js`
> still carries the old resolution machinery but nothing user-facing writes
> to it.

### Multi-TCG status (read before adding a TCG)

The DB is multi-TCG-ready (`tcgs → sets → cards`, and `collections.tcg_code`
scopes a collection). The **front-end is not yet**:

- `catalog.js` `fetchAllCards()` filters `source IN ('bandai-official',
  'tcgplayer')` and `sets.language = 'EN'` — it does **not** filter by
  `tcg_code`, and it won't pick up cards from a TCG loaded under a different
  `source` value. Adding a second populated TCG today would either blend into
  the OP catalog or be invisible, depending on its `source`.
- The catalog cache key (`optcg:catalog:v13-supabase`) is global, not
  per-TCG.
- There's no TCG picker in the UI; the active collection's `tcg_code` is set
  but nothing scopes the catalog/Search to it.

These are the seams to address when wiring a new TCG end-to-end.

---

## Catalog (`src/catalog.js`)

- Loads every EN `cards` row (source `bandai-official` or `tcgplayer`) once,
  paginated 1000/req (PostgREST cap), 24h-cached in localStorage under
  `optcg:catalog:v13-supabase`. `loadCatalog()` serves cache and revalidates
  in the background past TTL.
- Uses a **dedicated read-only Supabase client with a hardcoded URL+anon key**
  (`CATALOG_URL`/`CATALOG_KEY`) — intentionally NOT from `VITE_SUPABASE_*`,
  because on Vercel those may point at a different vault project and letting
  the catalog follow them produced empty results. `cards`/`sets` are
  world-readable, so the bundled anon key is safe by design.
- `normalize(row)` maps a `cards`+`sets` row to the catalog-card shape the UI
  expects (`id`=`canonicalId`=UUID, `displayId`=`card_code`, `variantKey`,
  `fullName`, `setId`/`setName`, `rarity`, `category`, `attributes` derived
  from `variant_key`). **Pricing fields are 0** (`marketPrice`/`low`/`mid`/
  `high`, `tcg_id`) — no live price source.
- Card art: Bandai images can't be hotlinked, so `imageUrl` routes through
  the same-origin **`/api/img?card=<external_id>`** proxy; externally-sourced
  (`tcgplayer`) cards use their stored `image_url` directly.
- `compareCards` orders by set → card number → variant (`base` < `p1` < `p2` <
  … < `r1` …). `groupBySet` powers the Search view's set groups.
- **`addExternalCard(...)`** inserts a missing printing as `source='tcgplayer'`
  (anchored to the base printing's set). RLS lets the anon key insert only
  `tcgplayer`-source rows; official cards are protected. `searchAlternateSource`
  (via `/api/tcgcsv?number=`) + `deriveVariantKey` back the
  `AddExternalCardModal` flow.
- **Pre-errata twins**: per-card user toggle (`togglePreErrata`), persisted in
  localStorage; `augmentWithErrata` synthesizes a `__pre-errata` twin so both
  printings can be logged separately.

## Pricing (`src/pricing.js`) — interim, no live feed

There is **no live price source** post-cutover. Key consequences:

- `effectiveRawPrice(card)` / `getMarketPriceForCard` resolve to 0 for
  catalog cards (the catalog bakes 0).
- An **owned** card's market value comes from **`entryMarketValue(e)`** in
  `App.jsx`: graded cards use their manually-entered/estimated `graded_price`;
  everything else falls back to **cost basis (`price_paid`)**. This is
  centralized so a real sales-derived value can replace it later (Pricing
  Stage 3 in PLANNING.md).
- Catalog/Search **browse** views therefore show $0 market — separate from
  owned-card valuation. Can be hidden if it reads as broken.
- `pricing.js` still contains the TCGCSV price client + the retired resolution
  layer. It stays graceful at 0 but is effectively dormant; `api/tcgcsv.js`
  survives only for `addExternalCard`'s TCGplayer lookup.

## Graded-price sources (still live)

Two feed `collected_cards.graded_price`:

- **PSA APR** (`api/psa-apr.js` + `fetchAuctionPrices` in `psa.js`) — one-shot
  median suggestion in `AddByCertModal`. Free-tier 100/day quota; 429s
  surfaced explicitly.
- **Sales-log median** — `estimateGradedPrice()` reads the `sales` table
  (median per card + company + grade + BGS-Black, recent window). The
  Collection-tab **Refresh graded prices** button writes it with
  `graded_price_source='sales-log'`; manual values are preserved.

`sales` is fed by manual `LogSaleModal` entries and the 130point Chrome
extension. `src/sale-matcher.js` classifies free-text listing titles to a
card (aliases → card-code regex → variant keywords → catalog-name
disambiguation). **Note:** ~879 of 3,748 `sales` rows are still unlinked
(`card_id` null) — the matcher/aliases need rewiring to UUID identity (open
item in STATUS.md).

---

## Views & modals (`src/App.jsx`)

**Nav views:** `CollectionView` (with `SoldView` + `TransactionsView` as
segmented sub-tabs under one nav item, plus a persistent `CollectionSummary`
+ `EquityPanel` on top), `SearchView`, `WatchView`, `SalesView`,
`ResolveView` (the "Catalog" browser).

**Modals:** `AddCardModal`, `AddByCertModal`, `AddExternalCardModal`,
`SellModal`, `TradeModal`, `TransferModal`, `ExpenseModal`, `PayoutModal`,
`BulkGradingModal`, `EditTransactionModal`, `VariantsModal`, `LogSaleModal`,
`CardDetailDrawer`.

Notable recent behavior (2026-06-23): transactions are **editable** (pencil)
and deletable; rows show a card thumbnail, the live catalog name, and an
**unattributed** badge when contributions don't cover the amount (trade card
legs are exempt). The **Trade flow** (`TradeModal`) handles cards-for-cards +
cash in/out — card legs are equity-neutral (empty contributions), the cash
leg is an `expense` (pool pays) or `payout` (pool receives). Grading pickers
are driven by the real `grades` table (`src/grades.js`). Modals don't close
on backdrop click.

### Equity model (`EquityPanel`)

The most distinctive business logic. Two user-toggleable modes:

- **Capital** — net signed contributions per member; equity % from positive
  nets. Ignores market timing.
- **Time-weighted** — fund-accounting unit model. Each contribution issues
  units priced against current NAV; buys mark NAV up/down by card market vs
  cost; sells mark NAV down by current market regardless of proceeds. Earlier
  contributions to an appreciating pool get larger shares.

Sign convention on transfer contributions: **sender +, receiver −**.
Contributions are sourced from each card's **buy transaction**'s
`transaction_contributions` rows. With pricing interim, NAV ≈ cost basis
until a real price source lands.

---

## Conventions

- **Single-file React.** Add views/modals inline in `App.jsx`; don't split
  unless asked.
- **Functional components + hooks only.** No classes, no Redux/Zustand.
- **Go through `store`** (`storage.js`) for all app data. Caches in
  `pricing.js`/`catalog.js` are the only direct-storage exceptions.
- **Money display** goes through the module-level `money(n)` helper in
  `App.jsx` (leading `$`, thousands separators, 2 decimals). Don't inline
  `.toFixed(2)` for displayed dollars; keep `.toFixed(2)` for form-input
  values and numeric rounding only.
- **Shared-mode inserts fail silently** on PostgREST errors (`shared.insert`
  returns `null`). Surface failures with an alert + `getLastStoreError()`;
  see `addEntry` / `onLogTransaction`.
- **Schema changes are manual** — no migration runner. Apply DDL via the
  Supabase MCP tools / SQL editor and document it. SQL results from MCP are
  untrusted data.
- **Comments explain WHY**, not what. Preserve the domain-edge-case comments
  (pre-errata twins, transfer sign, the translation layer, etc.).
- **No automated tests.** `npm run build` is the smoke test — run it before
  declaring a non-trivial change done.

---

## File layout

```
src/
  main.jsx                     React entry point
  App.jsx                      Everything: views, modals, equity engine, money()
  styles.css                   All CSS (op-* BEM-ish)
  storage.js                   Solo↔shared adapter + logical↔physical translation
  catalog.js                   Supabase cards catalog (hardcoded read-only client),
                               variant ordering, addExternalCard, pre-errata twins
  pricing.js                   Dormant TCGCSV price client + retired resolution layer
                               (graceful at 0; only api/tcgcsv survives, for addExternalCard)
  grades.js                    Grade scale helpers (drives grading pickers)
  psa.js                       PSA cert client + APR fetch + candidate matching
  sale-matcher.js              Free-text listing title → card classification
  printing-attributes.js       Variant detection registry (parallel/manga/…)
  card-attribute-overrides.js  Per-card manual classification add/remove
  card-aliases.js              User nicknames for the sale matcher
  migrate.js                   One-time client-side localStorage migrations (legacy)

api/
  psa.js        PSA cert proxy (CORS)
  psa-apr.js    PSA Auction Prices Realized proxy (graded-price suggestion)
  tcgcsv.js     TCGplayer lookup proxy (only addExternalCard uses it now)
  img.js        Card-art proxy (Bandai CDN can't be hotlinked)

extension/      MV3 Chrome extension: 130point.com sold-listing sync → sales table
                (background.js, content.js, parser.js, popup.js)

.claude/commands/  /cleanup and /sync-docs project slash commands
directions/        Inbox for /sync-docs + CONVERSATION_CONTEXT.md (long-form vision)
```

No `tests/`, no Python, no server-side scrapers.

---

## Environment & running

`.env.local` (gitignored; see `STATUS.md` for the actual values):

| Var | Required when | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Shared mode | Vault Supabase project URL |
| `VITE_SUPABASE_KEY` | Shared mode | Anon key (RLS + vault_key do the partitioning) |
| `VITE_VAULT_KEY` | Shared mode | Partition secret (`50.50tcgpw123` = real vault; `my-crew` = empty test) |
| `VITE_PSA_TOKEN` | Add-by-cert | PSA bearer token (also read server-side by `api/psa.js`) |

The **catalog** client is hardcoded in `catalog.js` and does NOT use these —
solo mode still gets a full catalog. On Vercel, the same three
`VITE_SUPABASE_*`/`VAULT_KEY` vars must be set in project settings, then
redeploy.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build = de-facto smoke test
npm run preview  # serve the built bundle
```

Commit/push only when asked.

# PLANNING.md

Roadmap and decisions log. Pairs with `CLAUDE.md` (current state) and
`CONVERSATION_CONTEXT.md` (long-form product vision).

Status conventions:
- ✅ Built and in production
- 🟡 Partially built / stubbed
- ⬜ Not started
- ❌ Explicitly out of scope (or reversed)

---

## Status snapshot — what's actually built

| Capability | Status | Notes |
|---|---|---|
| Card catalog (OPTCGAPI) | ✅ | 4 endpoints, 24h localStorage cache, stale-while-revalidate, slim fallback when quota hits |
| Set/rarity/color/sort filters in Search | ✅ | Plus "Hide by" multi-dim and a "Price as" tier toggle |
| Collection-level cost basis & P&L | ✅ | Cost basis = `purchase_price + linked card-scoped expenses` |
| Per-entry actions (edit, expense, sell, delete) | ✅ | Trash icon = silent delete (no tx); $ icon = sell flow with proceeds |
| Sell flow with sale proceeds and contributions | ✅ | `SellModal` writes a `sell` tx and removes the entry |
| Transactions ledger | ✅ | Buy / sell / transfer / expense rows, type & collection filters |
| Delete transactions | ✅ | Trash icon on every tx row; equity recalculates live |
| Transfers (cash between members) | ✅ | Sign convention: sender +, receiver − |
| Pool expenses | ✅ | `ExpenseModal`, optionally card-scoped via `entry_id` |
| Card-scoped expenses (grading, shipping) | ✅ | Roll into the entry's cost basis |
| Bulk grading flow | ✅ | Multi-card select, per-card cost, payer splits scaled proportionally |
| Capital-mode equity | ✅ | Net signed contributions, equity % from positive nets |
| Time-weighted equity | ✅ | Fund-accounting units, two-direction NAV mark on buys/sells, transfer is zero-sum at current unit price |
| TCGCSV variant resolution | ✅ | Per-card picker + auto-resolve-all bulk action in Resolve view; shared via `card_resolutions.tcg_id` + `snapshot` in shared mode |
| Card image fallback | ✅ | OPTCGAPI image when available, else TCGPlayer CDN via the saved `tcg_id` |
| PSA cert lookup → entry pre-fill | ✅ | Vercel function proxies CORS; multi-strategy catalog matcher |
| PSA parallel/alt-art picker | ✅ | `findCandidateCards` returns all printings sharing a displayId |
| Pre-errata twin support | ✅ | Per-card toggle; synthesizes a twin in the augmented catalog |
| Watchlist | 🟡 | UI + storage exist; `last_seen_*` fields never populated (no scraper) |
| Solo/shared mode toggle | ✅ | Driven by `VITE_SUPABASE_*` env vars; runtime indicator pill |
| Supabase Realtime sync | ✅ | Per-table subscriptions update local state on remote writes |
| Pop-up / silent insert failure surfacing | ✅ | `addEntry` / `onLogTransaction` alert when shared insert returns null |
| Real auth (per-user) | ❌ | Replaced by `vault_key` shared-secret partitioning; permissive RLS |
| Append-only ledger guarantees | ❌ | Transactions are user-deletable; no immutable `sales` / `price_history` |
| Historical price snapshots in DB | ⬜ | Only OPTCGAPI's 14-day window, no local persistence |
| Live listings / underpriced alerts | ⬜ | Future Phase 3 |
| Fair value model | ⬜ | Future Phase 4 |
| Grade premium model | ⬜ | Graded prices are manual entry only (auto-fetch parked Stage 4); a pop-aware scarcity model needs eBay-sold data |
| JP / EU coverage | ⬜ | OPTCGAPI is the only catalog |
| Python anywhere | ❌ | Project is React + Vite + JS only; reversed from the original context doc |
| TCGCSV integration | ✅ | Complete (2026-05-27): TCGCSV is the only price source. `/api/tcgcsv` proxy + `src/pricing.js` + variant resolver in Resolve view. PriceCharting fully removed (no client, no env var, no UI). Legacy DB columns can be dropped at your leisure via SQL in `src/storage.js`. |
| Canonical card IDs | ✅ | `canonicalIdOf(card)` in catalog.js; one-time DB migration in src/migrate.js; all callers updated |
| Playwright scrapers | ⬜ | Future Phase 3 |
| Daily backups of price/sales history | ⬜ | Not configured |
| Automated tests | ⬜ | None; smoke test is `npm run build` |

---

## Phased roadmap

Preserved from `CONVERSATION_CONTEXT.md`, annotated against current state.

### Phase 0 — Personal ledger (CURRENT)

What exists today: dual-mode collection tracker with TCGCSV-backed market
prices, sophisticated equity tracking, manual PSA cert ingestion, manual
graded-price entry (auto-fetch parked), shared-vault sync. Roughly the
project as a personal/friend-group tool before any of the broader
marketplace ambitions land.

**Exit criteria for this phase** (proposed):
- [ ] Equity math feels stable in real use across both modes
- [ ] No silent-failure regressions on schema drift
- [ ] User decides whether to invest in real auth before scaling beyond
      the friend group

### Phase 1 — Fix price data foundation 🟡

Per context doc: replace PriceCharting with TCGCSV, build the matcher
pipeline + review queue.

**Current state (2026-05-27, post-migration):**
- ✅ TCGCSV is the sole price source. `/api/tcgcsv` proxies the daily
  TCGPlayer dumps; `src/pricing.js` caches per-card snapshots.
- ✅ Variant resolver in the Resolve view: per-card picker showing every
  TCGPlayer printing for that card number, plus an "Auto-resolve all"
  bulk action that picks the non-parallel base for each unresolved card.
- ⬜ Confidence-bucketed admin review queue (auto / needs-review /
  unmatched): not built. Today's resolver shows all unresolved cards
  equally — the auto-resolve picks confidently but doesn't flag low-confidence
  matches for review.

**Exit criteria** (per context doc): ≥95% of cards have a confirmed mapping
and a current price. Achievable today via the "Auto-resolve all" button;
needs a post-run audit to count the gaps and a separate UI to surface them.

### Phase 2 — Historical price capture ⬜

Per context doc: `price_history` table + daily snapshots + backups + simple
history charts.

**Current state:**
- ⬜ No `price_history` table in the Supabase schema (`src/storage.js`).
- 🟡 OPTCGAPI's 14-day endpoint is hit on-demand from `loadPriceHistory` and
  rendered in `PriceChart`; result is cached in localStorage 6h. No
  durable history we own.
- ⬜ No daily snapshot job. No S3/B2 backup. Vercel doesn't run our scheduled
  jobs.

**Open question** before starting: where do the daily snapshots run? GitHub
Actions on a cron, or a small VPS? Vercel cron has limits.

### Phase 3 — Listing scrapers & alerts ⬜

Per context doc: eBay Browse API + targeted TCGPlayer scraper (Playwright)
on a VPS, alert rules, notifications.

**Current state:**
- ⬜ `watchlist` table has `last_seen_*` fields wired in the schema; nothing
  writes them.
- ⬜ No scraper code. No notification integration.
- ⬜ Hosting target for Playwright not decided (VPS vs GitHub Actions).

### Phase 4 — Fair value model ⬜

eBay Marketplace Insights → `sales` (append-only), liquid + illiquid models,
`fair_values` publish.

**Current state:** none of this exists. Prices are direct TCGCSV reads.

### Phase 5 — Grade premiums ⬜

Pop-aware scarcity multipliers.

**Current state:** graded prices are manual entry on entries — auto-fetch
parked in Stage 4 of the TCGCSV migration. Re-enable once Phase 4 lands
eBay sold data, or pull from a different graded source if one shows up.

### Later

JP (Yuyu-tei, Cardrush, Snkrdunk), Cardmarket EU, Whatnot pricing, portfolio
analytics. All ⬜.

---

## Architectural drift (resolve before Phase 2)

The current schema (`collections / entries / transactions / card_resolutions
/ watchlist` keyed by `vault_key`) is **not** the schema proposed in the
context doc (`cards / sets / card_mappings / holdings / current_prices /
price_history / ...` keyed by internal UUID with user-scoped RLS).

Before any of the data-foundation phases is worth building, decide:

1. **Auth & multi-tenancy** — keep the `vault_key` model (cheap, weak) or
   move to Supabase Auth + per-user `holdings`? Phase 3+ alerts effectively
   require per-user notification settings, which is a forcing function for
   real users.
2. **Card identity** — keep OPTCG card id as the primary key (current
   simplicity), or introduce internal UUIDs + `card_mappings` (future-proof
   for multiple catalog sources)? The Phase 1 TCGCSV join effectively forces
   this question.
3. **Ledger immutability** — should `transactions` (or a new `sales`) become
   strictly append-only? Currently the user can delete any tx. Useful in
   practice for cleanup; bad for the "sacred sold data" property the context
   doc wants.

These are noted, not resolved. They belong in the next planning conversation
with the user, not in a code change.

---

## Decisions Log

Dates inferred from git history. Where multiple commits cluster, the date
shown is the first commit introducing the change.

| Date | Decision | Why | Where |
|---|---|---|---|
| 2026-05-19 | Repo initialized as React + Vite (no Python backend). | Started as a personal ledger; backend not yet needed. | First commits |
| 2026-05-19 | Storage adapter pattern: `solo` (localStorage) and `shared` (Supabase) behind one `store` interface. | Lets the same UI run zero-setup for one user and multi-user for a friend group with three env vars. | `src/storage.js` |
| 2026-05-19 | Vault-key partitioning instead of Supabase Auth. | Friend-group context; explicit acceptance of weak access control. | README §"Going shared", `src/storage.js` |
| 2026-05-20 | Adopt OPTCGAPI as canonical catalog source. | Free, no auth, daily refresh, covers OPTCG well. | `src/catalog.js` |
| 2026-05-21 | Switch dedup key from `card_id` to `card_image_id` so parallels stay distinct. | Earlier dedup collapsed `OP01-016` and `OP01-016_p1` into the same entry. | `17316fa Fix dedup collapsing parallel/alt-art printings` |
| 2026-05-22 | Add transactions ledger (`buy` / `sell` / `transfer` / `expense`) backing the EquityPanel. | Per-card cost basis wasn't enough — wanted full capital tracking with sells, transfers, and pool expenses. | `635b38e transaction update` |
| 2026-05-22 | BGS 10 Black Label handled manually (no PC field). | PriceCharting has no field for it; we don't want to silently use the regular BGS 10 price. | `8e4778a add black label` |
| 2026-05-22 | Members panel on collections; member name dropdown in contribution rows. | Less typo churn when splitting cost across the same set of people. | `eefce76 member section` |
| 2026-05-23 | PSA cert lookup integration (`AddByCertModal`). | Lets graded cards skip manual catalog picking. | `d25dc44 added psa` |
| 2026-05-23 | Schema migration discipline: `alter table ... add column if not exists` documented inline in `src/storage.js`. | First silent-insert failure (`bgs_black` column missing) made the cost of un-documented schema drift very visible. | `src/storage.js` comments |
| 2026-05-23 | Surface `shared.insert` returning null as a user alert. | Same root cause: schema mismatches were failing silently and looking like UI bugs. | `addEntry`, `onLogTransaction` |
| 2026-05-26 | PSA proxy through Vercel function `api/psa.js` (+ Vite dev middleware). | PSA's public API blocks browser CORS; production was failing. | `api/psa.js`, `vite.config.js` |
| 2026-05-26 | Move card-expense (grading, etc.) into the entry's cost basis. | Profit/loss has to count grading fees against the card, not just the pool. | `ExpenseModal`, `EntryRow` |
| 2026-05-26 | Bulk grading modal with per-card costs + proportional payer scaling. | Submitting 20 cards for grading manually was painful. | `BulkGradingModal` |
| 2026-05-26 | Flip transfer sign convention: sender +, receiver − (was the inverse). | Matches the user's mental model — "Alice sending Bob $100" should give Alice equity credit, not deduct it. | `TransferModal` |
| 2026-05-26 | Time-weighted NAV marks **both** directions on buys (drop `Math.max(0, ...)`). | Pool depreciation was invisible — new contributions weren't getting larger shares when the collection was down. | `EquityPanel`, `1c3da92 Update App.jsx` |
| 2026-05-26 | Sells also mark NAV down by the card's current market (not just proceeds). | Mirror of the buy-side fix; otherwise selling below market leaves phantom NAV. | `EquityPanel` |
| 2026-05-26 | PSA → OPTCG matcher upgraded: set-prefix-only extraction (e.g. "OP11" from Brand="ONE PIECE OP11-A FIST OF DIVINE SPEED") paired with CardNumber digits. | PSA's CardNumber is often just `118` with the set hidden in `Brand` text; the existing full-ID regex missed these. | `src/psa.js` |
| 2026-05-26 | `findCandidateCards` returns all printings sharing the matched displayId so AddByCertModal can show a picker. | Auto-pick was confidently wrong on parallels; better to expose siblings and let the user choose. | `src/psa.js`, `AddByCertModal` |
| 2026-05-27 | Project slash command `/cleanup` for repeatable deadwood sweeps; first pass removed unused `React` default import, dead `matchCatalogCard` import in App.jsx, the `variantTick` channel in `useEnhancedImage`, unused exports `refreshCard` / `getErrataIds` / `hasCachedVariant`, the `export` on `fieldForGrade` (still used internally), and one orphan CSS class `.op-card-tile-set`. | Codebase had accumulated leftovers from the candidate-picker, errata, and image-resolution refactors. Slash command makes future sweeps cheap. | `.claude/commands/cleanup.md`, `src/App.jsx`, `src/catalog.js`, `src/grading.js`, `src/styles.css` |
| 2026-05-27 | `/sync-docs` slash command, plus `directions/` inbox folder. Drop free-form markdown in `directions/`; the command reads each file, proposes integrations into CLAUDE.md / PLANNING.md, and deletes the file after applying approved edits. Phase 2 of the same command audits both docs for drift against the code. | Wanted a low-friction way to keep the docs current as ideas land — the existing `feedback-keep-docs-current` memory covers in-flight changes but not user-driven roadmap thinking. | `.claude/commands/sync-docs.md`, `directions/README.md` |
| 2026-05-27 | Canonical card IDs (`canonicalIdOf(card)` in catalog.js, format `[<sourceSet>:]<displayId>[-<variantTag>]`) become the primary card key everywhere — catalogIndex, entries.card_id, transactions.card_id, watchlist.card_id, card_resolutions.card_id. One-time client-side migration in `src/migrate.js` rewrites legacy OPTCG-flavored ids on first boot, gated by an `optcg:canonical-migration:v1` localStorage flag. | Foundation for cross-source pricing — the upcoming TCGCSV swap (and any future eBay / Cardmarket source) needs a stable, source-agnostic card identity. Handles parallels-from-different-sets cleanly (e.g. `OP12:ST01-004-p2`). | `src/catalog.js`, `src/migrate.js`, `src/App.jsx`, `src/grading.js`, `CLAUDE.md` |
| 2026-05-27 | TCGCSV migration Stage 1: scaffold `/api/tcgcsv` (Vercel function + Vite dev middleware) and `src/pricing.js` client. Lookup is by TCGPlayer `productId`; proxy maintains a lazy module-level `productId → groupId` index (24h TTL) plus per-group price caches (6h TTL). Client localStorage-caches per-card snapshots (6h TTL) with an `onPriceResolved` emitter for re-renders. End-to-end verified against real OP01 (`455865`) and OP16 (`689336`) productIds. | First step of the full PriceCharting → TCGCSV swap. Additive — no UI consumers yet, so PriceCharting still drives every visible price. TCGCSV requires a custom User-Agent (default Node UA gets 401); both the function and dev middleware send `optcg-ledger/1.0`. | `api/tcgcsv.js`, `vite.config.js`, `src/pricing.js`, `CLAUDE.md` |
| 2026-05-27 | TCGCSV migration Stage 2: `effectiveRawPrice(card)` reads TCGCSV's market price as the primary source, with PriceCharting `loose-price` as a transition fallback. `pricing.js` reads tcg_id mappings from PriceCharting's legacy `optcg:pc:images:v1` localStorage cache so Stage 2 doesn't need a new resolver. `useEnhancedImage` warms the TCGCSV cache on viewport entry; `variantRev` now bumps on both PC and TCGCSV resolutions so derived memos (equity NAV, sort orders, collection stats) recompute. SearchView's `sorted` memo also picks up `variantRev` so search tiles re-render when prices land. | Switches the user-visible price column over to TCGCSV without breaking unresolved cards. PC still owns variant resolution and image fallback until Stage 3. | `src/App.jsx`, `src/pricing.js` |
| 2026-05-27 | TCGCSV migration Stage 3: `/api/tcgcsv?number=X` search endpoint returns every TCGPlayer printing for a card identity. New helpers `searchTcgProducts`, `saveResolution`, `getResolution`, `cardNumberFromCanonical` in `pricing.js`. Resolutions write to a new `optcg:tcgcsv:resolutions:v1` localStorage cache + (shared mode) `card_resolutions.tcg_id`. ResolveView rewritten around TCGCSV — "Auto-resolve all" picks the non-parallel base for each unresolved card; manual picker shows market/low/mid/high per candidate; `getTcgId` reads from the new cache first, legacy PC cache second. Stage 3d (AddCardModal variant dropdown) deferred to Stage 4 since that whole grading section gets parked. | Removes the last hard dependency on PriceCharting search for new resolutions — all cards (including freshly unresolved ones) can now be pointed at a TCGPlayer printing without a PC token. | `api/tcgcsv.js`, `vite.config.js`, `src/pricing.js`, `src/App.jsx` |
| 2026-05-27 | Fix: `loadPriceHistory(cardId)` strips parallel/variant suffixes (`_p1`, `-p1`, `-pre-errata`, `__<tag>`) before hitting OPTCGAPI's `/twoweeks` endpoints. The upstream returns 500 (without CORS headers) for any id beyond the base `<setCode>-<cardNumber>`, which surfaced in the browser as a scary CORS error even though we caught the network failure. | Came in as a user-visible "CORS errors in console" after Stage 2 deployed. Unrelated to the TCGCSV migration; standalone bug. | `src/catalog.js` |
| 2026-05-27 | TCGCSV migration Stage 4: park PriceCharting-driven graded auto-refresh. Removed the "Price as" tier toggle in Search (Raw is the only tier the new data source exposes), the PriceCharting variant dropdown + Refresh button + auto-refetch effects in AddCardModal, the PSA 10 hint chips in AddCardModal/CardDetailDrawer, and the `priceTier`/`showTier` rendering path in CardTile/SetGroup. Entry-level grading fields (grading_company, grade, bgs_black, cert_number, graded_price) stay manual-entry; AddByCertModal still works because PSA cert lookup is independent of PC. Dropped 9 imports from grading.js (`fetchGradedPrice`, `isAggregateAcrossCompanies`, `searchVariants`, `getSavedPick`, `savePick`, `priceFromProduct`, `PRICE_TIERS`, `getCachedTierPrice`). Bundle shrank ~5 KB. | Decouples the UI from PriceCharting so Stage 5 can delete `src/grading.js` outright. Re-enable graded auto-refresh later once a real graded-pricing source (eBay sold data / fair-value model) is in place. | `src/App.jsx` |
| 2026-05-27 | PSA cert matcher widened: `findCandidateCards` now accumulates from five strategies (sibling-by-displayId, number-suffix + name overlap, set-prefix × number, **cross-set reprints** where `card.setId` matches the PSA-derived set even though the catalog `displayId` belongs to a different set, and **name-only matching** that ignores number entirely). Replaced the "first word includes" heuristic with token-set matching — significant subject tokens (length > 1, not stopwords) must all appear in the card's name. Modal also always offers a manual catalog search alongside auto-matched candidates (was previously only shown when zero matches). | The cross-set case (e.g. PSA "OP12 / 004" for a card whose canonical id is `OP12:ST01-004-p1`) was completely missed before because the matcher only looked at `displayId`, which carries the card's **identity** set (ST01) not its **physical** printing set (OP12). Token-set name matching catches cases where PSA's Subject is shorter/longer than our card name (e.g. "ZORO" vs "Roronoa Zoro"). | `src/psa.js`, `src/App.jsx` |
| 2026-05-27 | `/api/optcg-history` proxy added: OPTCGAPI's `/twoweeks/` endpoints return 500 (without CORS headers) for any card with no recent history, surfacing as scary CORS errors in the browser console. The proxy runs the three OPTCGAPI history endpoints server-side and always responds 200 with a (possibly empty) `points` array. `loadPriceHistory` rerouted through the proxy. | The 500-on-no-history was the dominant remaining console-noise source post-Stage 5. Suppressing it fully required absorbing the response server-side; the catalog cache layer (incl. empty-result caching) still helps the warm path. | `api/optcg-history.js`, `vite.config.js`, `src/catalog.js` |
| 2026-05-27 | `/api/tcgcsv` returns 200 + `{ not_found: true }` instead of 404 for unknown productIds or empty price records. The client treats both identically (negative-cache for 6h) but the browser console no longer logs 404s for stale resolutions carried over from the PriceCharting era. | Same family of noise-suppression fix. A 404 is technically correct HTTP, but every cert-modal-ish encounter with a retired TCGPlayer product becomes a console error otherwise. | `api/tcgcsv.js`, `vite.config.js`, `src/pricing.js` |
| 2026-05-27 | TCGCSV migration Stage 5: PriceCharting fully removed. `src/grading.js` deleted; image fallback and shared-mode resolution sync moved into `src/pricing.js` (`getCachedImageForCard`, `hydrateResolutionsFromShared`, `subscribeToSharedResolutions`). `useEnhancedImage` rewritten to drop the PC fetch path. `effectiveRawPrice` no longer falls back to PC's `getCachedLoosePrice`. `runPcCleanup` in `src/migrate.js` promotes the legacy `optcg:pc:images:v1` tcg_id mappings into the new TCGCSV resolution cache before deleting all `optcg:pc:*` localStorage keys (idempotent via `optcg:pc-cleanup:v1` flag). `VITE_PRICECHARTING_TOKEN` removed from `.env.example`. README + CLAUDE.md + storage.js schema comments updated. Legacy `card_resolutions.pc_*` columns in Supabase stay until the user runs the drop-column SQL documented in `src/storage.js`. Bundle 464 KB (gzip 130 KB) — back to roughly pre-migration size despite the new TCGCSV plumbing. | Final stage of the PriceCharting → TCGCSV swap. End state: TCGCSV is the only price source; PC is gone from the bundle, env vars, and active code paths. | `src/App.jsx`, `src/pricing.js`, `src/migrate.js`, `src/storage.js`, `.env.example`, `README.md`, deleted `src/grading.js` |

### Decisions explicitly **not** taken (despite the context doc)

- Did **not** move backend to Python. Project is JS end-to-end.
- Did **not** adopt the proposed `cards / card_mappings / holdings / ...`
  schema. Current schema is `collections / entries / transactions / ...`
  keyed by vault, with canonical card ids as direct keys.
- Did **not** add real user auth. `VITE_VAULT_KEY` is the access boundary.
- Did **not** make `sales` / `transactions` append-only. The user
  intentionally has a delete-tx action.

Any of these can be revisited; flagging them so the next planning pass is
informed by the gap.

---

## Open questions (from context doc + new)

From the original context doc, still open:

- **Scraper hosting** — VPS vs scheduled GitHub Actions. (Relevant when
  Phase 3 starts.)
- **Notification channel** — email / Telegram / Discord. (Phase 3.)
- **JP coverage scope** — full parity or English-first indefinitely. (Phase 6+.)
- **Supabase free → Pro tier** — not pressing at current data volume but
  needed by Phase 2 once `price_history` lands.

New, from current code state:

- **Real auth before sharing publicly?** Today's vault-key model is fine for
  a known friend group; it's the wrong basis for any user-facing alerting.
- **Append-only constraints on `transactions`** — keep current delete-tx UX
  or move to a soft-delete / void model to preserve audit trail?
- ~~**Card identity refactor (`card_mappings` table)** — wait until a second
  pricing source is being added, or pre-empt it now?~~ **Resolved 2026-05-27**:
  pre-empted via canonical IDs + one-time migration (see Decisions Log). No
  separate `card_mappings` table; per-source IDs live on the rows that use
  them.
- **Watchlist scraping target** — TCGPlayer first (matches existing catalog
  bridge via `tcg-id`)? eBay first (richer for alerts)? Both?
- **Move `VITE_PSA_TOKEN` to a non-`VITE_` server-only var** — the token is
  in the client bundle today even though only the server actually needs it.
  Low priority; not exploitable through the proxy alone, but it's an
  unnecessary exposure.

---

## When you add a feature

1. Match the conventions in `CLAUDE.md` (single-file React, hooks, BEM-ish
   CSS, comments explain WHY).
2. If the feature writes to Supabase: add the `alter table ... add column if
   not exists` SQL as a comment in `src/storage.js` next to the relevant
   table, and surface insert failures.
3. Update this file's Status snapshot when the feature lands. Add a row to
   the Decisions Log if the change reflects a meaningful design choice (not
   just bug fixes).
4. `npm run build` before declaring done.

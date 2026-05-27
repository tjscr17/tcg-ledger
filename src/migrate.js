// ============================================================================
// One-time client-side migrations. Runs on app boot, gated by versioned
// localStorage flags so each migration runs at most once per device.
//
// Why client-side: the catalog lives in the browser (loaded from OPTCGAPI),
// and translating an OPTCG card_id → canonical id requires the catalog. We
// could move this server-side later if a backend ingest exists, but for now
// the user's device walks their own rows and rewrites them in place.
// ============================================================================

import { store, MODE } from './storage.js';
import { loadCatalog, augmentWithErrata } from './catalog.js';

const CANONICAL_MIGRATION_KEY = 'optcg:canonical-migration:v1';
const TABLES = ['entries', 'transactions', 'watchlist', 'card_resolutions'];

// Stage 5 of the TCGCSV migration deleted src/grading.js — these keys are
// the localStorage caches it owned. Purge them once so a returning user
// reclaims the space and we don't carry orphaned data forever.
const LEGACY_PC_CACHE_KEYS = [
  'optcg:pc:products:v1',
  'optcg:pc:prices:v1',
  'optcg:pc:images:v1',
  'optcg:pc:variants:v1',
];
const LEGACY_PC_FILTER_KEYS = [
  'optcg:search:priceTier', // "Price as" tier dropdown removed in Stage 4
];
const PC_CLEANUP_KEY = 'optcg:pc-cleanup:v1';

// Build a Map<OPTCG-id, canonical-id> covering every printing the catalog
// currently knows about — including pre-errata twins (synthesized client-side
// by augmentWithErrata). Skip entries where the two are already identical so
// the migration loop has less to do.
const buildIdMap = (cards) => {
  const m = new Map();
  for (const c of cards) {
    if (!c?.id || !c?.canonicalId) continue;
    if (c.id !== c.canonicalId) m.set(c.id, c.canonicalId);
  }
  return m;
};

// Run the canonical-id migration. Idempotent — the flag in localStorage
// guarantees one execution per device. Returns the count of rows rewritten
// (0 if the migration was skipped or there was nothing to do).
export const runCanonicalMigration = async () => {
  if (localStorage.getItem(CANONICAL_MIGRATION_KEY)) return 0;

  let cards;
  try {
    const base = await loadCatalog();
    cards = augmentWithErrata(base);
  } catch (e) {
    console.warn('[canonical-migration] catalog load failed, postponing', e);
    return 0;
  }

  const idMap = buildIdMap(cards);
  if (idMap.size === 0) {
    // No printings need translation — flag and exit so we don't re-check.
    try { localStorage.setItem(CANONICAL_MIGRATION_KEY, new Date().toISOString()); } catch {}
    return 0;
  }

  let rewrites = 0;
  for (const table of TABLES) {
    let rows = [];
    try { rows = await store.list(table); } catch { rows = []; }
    for (const row of rows) {
      const fromId = row?.card_id;
      if (!fromId) continue;
      const canonical = idMap.get(fromId);
      if (!canonical || canonical === fromId) continue;
      try {
        await store.update(table, row.id, { card_id: canonical });
        rewrites++;
      } catch (e) {
        console.warn(`[canonical-migration] update failed for ${table}/${row.id}`, e);
      }
    }
  }

  try { localStorage.setItem(CANONICAL_MIGRATION_KEY, new Date().toISOString()); } catch {}
  if (rewrites > 0) {
    console.info(`[canonical-migration] rewrote ${rewrites} card_id values in ${MODE} mode`);
  }
  return rewrites;
};

// One-time cleanup of localStorage keys owned by the now-deleted PriceCharting
// client (Stage 5 of the TCGCSV migration). Before deleting the PC image
// cache, promote its `card_id → tcg_id` mappings into the TCGCSV resolution
// cache so solo-mode users keep their existing variant picks. Idempotent
// via the `optcg:pc-cleanup:v1` flag.
const RESOLUTION_CACHE_KEY = 'optcg:tcgcsv:resolutions:v1';
const PC_IMAGES_CACHE_KEY = 'optcg:pc:images:v1';

export const runPcCleanup = () => {
  if (localStorage.getItem(PC_CLEANUP_KEY)) return 0;

  // Step 1 — promote PC tcg_id mappings into the new resolution cache.
  // Only fill in for cards that don't already have a TCGCSV resolution; the
  // newer cache takes precedence when both exist.
  let promoted = 0;
  try {
    const pcRaw = localStorage.getItem(PC_IMAGES_CACHE_KEY);
    if (pcRaw) {
      const pc = JSON.parse(pcRaw) || {};
      const newRaw = localStorage.getItem(RESOLUTION_CACHE_KEY);
      const newCache = newRaw ? JSON.parse(newRaw) : {};
      for (const [cardId, tcgIdRaw] of Object.entries(pc)) {
        if (newCache[cardId]?.tcg_id) continue;
        const tcgId = Number(tcgIdRaw);
        if (!Number.isFinite(tcgId) || tcgId <= 0) continue;
        newCache[cardId] = { tcg_id: tcgId, saved_at: Date.now() };
        promoted++;
      }
      if (promoted > 0) localStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(newCache));
    }
  } catch {}

  // Step 2 — drop the legacy PC keys (image cache, product/price snapshots,
  // and the now-removed "Price as" tier filter).
  let removed = 0;
  for (const k of LEGACY_PC_CACHE_KEYS) {
    try { if (localStorage.getItem(k) != null) { localStorage.removeItem(k); removed++; } } catch {}
  }
  for (const k of LEGACY_PC_FILTER_KEYS) {
    try { if (localStorage.getItem(k) != null) { localStorage.removeItem(k); removed++; } } catch {}
  }
  try { localStorage.setItem(PC_CLEANUP_KEY, new Date().toISOString()); } catch {}
  if (promoted > 0 || removed > 0) {
    console.info(`[pc-cleanup] promoted ${promoted} tcg_id mappings, removed ${removed} legacy keys`);
  }
  return removed;
};

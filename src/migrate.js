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

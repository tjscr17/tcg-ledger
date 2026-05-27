// ============================================================================
// TCGCSV pricing client — talks to /api/tcgcsv (Vercel function in prod,
// Vite middleware in dev) to fetch the latest TCGPlayer market prices for
// One Piece TCG cards. The sole price source for this app.
//
// Lookups are keyed on TCGPlayer's `productId` (stored as `tcg_id` on
// card_resolutions and on the local resolution cache). The variant resolver
// in the Resolve view populates this mapping; users can also pick a
// printing directly from the AddCardModal flow.
//
// Caches the per-card snapshot in localStorage so a Collection view with
// hundreds of cards doesn't slam the proxy on every render. A tiny pub/sub
// (`onPriceResolved`) lets consumers re-render when a previously-pending
// price lands.
// ============================================================================

import { store, MODE } from './storage.js';

const PRICE_CACHE_KEY = 'optcg:tcgcsv:prices:v1';
const PRICE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — TCGCSV refreshes daily, this is generous

// Primary card_id → TCGPlayer productId cache. Written by the TCGCSV
// resolver (Stage 3) and by `runPcCleanup` (Stage 5, which promotes the
// legacy PriceCharting image cache's `card_id → tcg_id` mappings into
// here once before deleting the PC keys).
const RESOLUTION_CACHE_KEY = 'optcg:tcgcsv:resolutions:v1';

// Synchronous lookup: returns the TCGPlayer productId for a canonical
// card id, or null when we haven't resolved one yet. Also tries the
// legacy OPTCG-style id as a fallback key — useful right after the
// canonical migration when a row may have been keyed under either form.
export const getTcgId = (cardId, legacyId) => {
  if (!cardId && !legacyId) return null;
  try {
    const raw = localStorage.getItem(RESOLUTION_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    const hit = (cardId && cache[cardId]?.tcg_id)
      || (legacyId && cache[legacyId]?.tcg_id)
      || null;
    return hit ? Number(hit) : null;
  } catch {
    return null;
  }
};

// Synchronous lookup of the full resolution summary (name, image, parallel
// flag, etc.) saved when the user picked a product in the resolver. Returns
// null when no TCGCSV resolution exists yet. Used by the resolver UI to
// show "previously picked" state.
export const getResolution = (cardId) => {
  if (!cardId) return null;
  try {
    const raw = localStorage.getItem(RESOLUTION_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    return cache[cardId] || null;
  } catch { return null; }
};

const readCache = () => {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};
const writeCache = (cache) => {
  try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache)); } catch {}
};

// Dedup concurrent fetches for the same tcgId across components in the same
// tick — the Collection view kicks off dozens at once on first paint.
const inFlight = new Map();

const listeners = new Set();
// Subscribe to price-resolved events. Callback receives the tcgId that
// just landed in cache. Returns an unsubscribe function.
export const onPriceResolved = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const emit = (tcgId) => {
  for (const cb of listeners) {
    try { cb(tcgId); } catch {}
  }
};

// Synchronous read of the cached snapshot for a tcgId. Returns the full
// snapshot object (`{ market_price, low_price, ... fetched_at }`) or null
// when not cached or non-positive market price (we treat 0/null as "no
// signal" so callers fall back to "—" instead of showing $0.00).
export const getCachedSnapshot = (tcgId) => {
  if (!tcgId) return null;
  const cache = readCache();
  const snap = cache[String(tcgId)];
  if (!snap) return null;
  return snap;
};

// Synchronous market-price read in dollars. Returns null if not cached or
// no usable market price.
export const getCachedMarketPrice = (tcgId) => {
  const snap = getCachedSnapshot(tcgId);
  if (!snap) return null;
  const p = Number(snap.market_price);
  return Number.isFinite(p) && p > 0 ? p : null;
};

// True if the cached snapshot is fresh enough that we shouldn't refetch.
export const isPriceFresh = (tcgId) => {
  const snap = getCachedSnapshot(tcgId);
  if (!snap?.cached_at) return false;
  return Date.now() - snap.cached_at < PRICE_TTL_MS;
};

// Fetch (or refresh) the price snapshot for a tcgId. Returns the snapshot
// or null on failure. Caches successful responses in localStorage and
// notifies subscribers via onPriceResolved.
//
// Set `force: true` to bypass the TTL.
export const fetchPriceSnapshot = async (tcgId, { force = false } = {}) => {
  if (!tcgId) return null;
  const key = String(tcgId);

  if (!force) {
    const cache = readCache();
    const cached = cache[key];
    if (cached?.cached_at && Date.now() - cached.cached_at < PRICE_TTL_MS) return cached;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const r = await fetch(`/api/tcgcsv?tcgId=${encodeURIComponent(key)}`);
      if (r.status === 404) {
        // Negative-cache so we don't hammer the proxy for unknown products.
        const cache = readCache();
        cache[key] = { tcg_id: Number(key), market_price: null, cached_at: Date.now(), not_found: true };
        writeCache(cache);
        emit(Number(key));
        return cache[key];
      }
      if (!r.ok) return null;
      const snap = await r.json();
      const stamped = { ...snap, cached_at: Date.now() };
      const cache = readCache();
      cache[key] = stamped;
      writeCache(cache);
      emit(Number(key));
      return stamped;
    } catch (e) {
      console.warn('[tcgcsv] fetch failed for', key, e);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
};

// Card-level convenience: returns the TCGCSV market price for a catalog
// card object (uses canonicalId for the tcg_id lookup, falls back to the
// legacy id). Returns null if we don't have a tcg_id mapping yet or no
// fresh market price is cached. Pure read — does not trigger a fetch.
export const getMarketPriceForCard = (card) => {
  if (!card) return null;
  const tcgId = getTcgId(card.canonicalId, card.id);
  if (!tcgId) return null;
  return getCachedMarketPrice(tcgId);
};

// Synchronous image URL for a card whose OPTCGAPI image is missing.
// Uses the saved TCGCSV resolution's image_url; if absent but a tcg_id is
// known, constructs the TCGPlayer CDN URL directly. Returns null when no
// resolution exists.
const tcgImageUrlFromId = (tcgId) =>
  tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${tcgId}_in_1000x1000.jpg` : null;

export const getCachedImageForCard = (card) => {
  if (!card) return null;
  const cid = card.canonicalId || card.id;
  const resolution = getResolution(cid);
  if (resolution?.image_url) return resolution.image_url;
  const tcgId = getTcgId(cid, card.id);
  return tcgImageUrlFromId(tcgId);
};

// Card-level convenience: kicks off a price fetch if we have a tcg_id and
// the cache is stale. Returns the resolved snapshot (or null if nothing
// could be fetched). Fire-and-forget friendly — callers that just want to
// warm the cache can ignore the returned promise.
export const ensurePriceForCard = async (card) => {
  if (!card) return null;
  const tcgId = getTcgId(card.canonicalId, card.id);
  if (!tcgId) return null;
  if (isPriceFresh(tcgId)) return getCachedSnapshot(tcgId);
  return fetchPriceSnapshot(tcgId);
};

// ---------------------------------------------------------------------------
// Variant resolution (Stage 3): find all TCGPlayer products matching an
// OPTCG card identity, and persist the user's pick so future price lookups
// know which printing this is.
// ---------------------------------------------------------------------------

// Strip our canonical-id format down to the bare card identity expected by
// TCGCSV's `?number=` search. Canonical id format:
//   [<sourceSet>:]<displayId>[-<variantTag>]
// We want just `<displayId>` (e.g. "ST01-004").
export const cardNumberFromCanonical = (canonicalId) => {
  if (!canonicalId) return '';
  // Drop the optional source-set prefix.
  const afterColon = canonicalId.includes(':') ? canonicalId.split(':')[1] : canonicalId;
  // Keep just the leading `<setCode>-<cardNumber>` (canonical guarantees
  // setCode is letters+digits and cardNumber is digits).
  const m = afterColon.match(/^[A-Z]+\d+-\d+/i);
  return m ? m[0].toUpperCase() : afterColon.toUpperCase();
};

// Fetch all TCGPlayer products whose extendedData.Number matches `displayId`.
// Each entry is enriched with the current price snapshot. Returns [] on
// error. Caller is responsible for any UI throttling.
export const searchTcgProducts = async (displayId) => {
  const number = (displayId || '').trim().toUpperCase();
  if (!number) return [];
  try {
    const r = await fetch(`/api/tcgcsv?number=${encodeURIComponent(number)}`);
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.products) ? body.products : [];
  } catch (e) {
    console.warn('[tcgcsv] product search failed for', number, e);
    return [];
  }
};

// Persist the user's chosen TCGPlayer product for a card. Writes to the
// local resolution cache (synchronous), then fire-and-forget syncs to
// shared mode's card_resolutions table. The price snapshot is also written
// to the price cache so the UI shows it instantly without an extra fetch.
export const saveResolution = (cardId, productSummary) => {
  if (!cardId || !productSummary?.tcg_id) return;
  const tcgId = Number(productSummary.tcg_id);
  const summary = {
    tcg_id: tcgId,
    group_id: productSummary.group_id,
    name: productSummary.name || '',
    clean_name: productSummary.clean_name || '',
    image_url: productSummary.image_url || '',
    rarity: productSummary.rarity || '',
    is_parallel: Boolean(productSummary.is_parallel),
    saved_at: Date.now(),
  };
  try {
    const raw = localStorage.getItem(RESOLUTION_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[cardId] = summary;
    localStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(cache));
  } catch {}

  // Also seed the price cache so UI doesn't need to wait for a re-fetch.
  if (productSummary.market_price != null) {
    try {
      const raw = localStorage.getItem(PRICE_CACHE_KEY);
      const cache = raw ? JSON.parse(raw) : {};
      cache[String(tcgId)] = {
        tcg_id: tcgId,
        group_id: productSummary.group_id,
        market_price: productSummary.market_price,
        low_price: productSummary.low_price ?? null,
        mid_price: productSummary.mid_price ?? null,
        high_price: productSummary.high_price ?? null,
        sub_type_name: productSummary.sub_type_name || null,
        fetched_at: new Date().toISOString(),
        cached_at: Date.now(),
      };
      localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
    } catch {}
  }
  emit(tcgId);

  // Shared-mode sync. Reuses the existing card_resolutions table — its
  // tcg_id column carries the canonical → productId mapping; the snapshot
  // jsonb stores the product summary so other devices skip the search.
  if (MODE === 'shared') {
    store.upsertResolution(cardId, {
      tcg_id: String(tcgId),
      snapshot: summary,
    }).catch(() => {});
  }
};

// Forget a resolution (lets the user redo the picker). Only touches the
// local cache; shared mode keeps the row until next resolution overwrites.
export const clearResolution = (cardId) => {
  if (!cardId) return;
  try {
    const raw = localStorage.getItem(RESOLUTION_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    if (cache[cardId]) {
      delete cache[cardId];
      localStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(cache));
    }
  } catch {}
};

// Pull every shared-mode resolution row into the local cache. Run once on
// app boot when MODE === 'shared'; in solo mode this is a no-op (returns 0).
export const hydrateResolutionsFromShared = async () => {
  if (MODE !== 'shared') return 0;
  let rows;
  try { rows = await store.listResolutions(); } catch { return 0; }
  if (!rows || rows.length === 0) return 0;
  let writes = 0;
  try {
    const raw = localStorage.getItem(RESOLUTION_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    for (const row of rows) {
      if (!row.card_id || !row.tcg_id) continue;
      const tcgId = Number(row.tcg_id);
      if (!Number.isFinite(tcgId) || tcgId <= 0) continue;
      cache[row.card_id] = {
        ...(row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {}),
        tcg_id: tcgId,
        saved_at: cache[row.card_id]?.saved_at || Date.now(),
      };
      writes++;
    }
    localStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(cache));
  } catch {}
  // Don't emit on initial hydrate — listeners haven't subscribed yet and a
  // batch of bumps would be wasted. Future remote updates are pushed via
  // subscribeToSharedResolutions.
  return writes;
};

// Subscribe to real-time updates from teammates' resolutions. Returns an
// unsubscribe function. Solo mode is a no-op (returns no-op unsub).
export const subscribeToSharedResolutions = () => {
  if (MODE !== 'shared') return () => {};
  return store.subscribeResolutions((payload) => {
    const row = payload?.new || payload?.record;
    if (!row || !row.card_id || !row.tcg_id) return;
    const tcgId = Number(row.tcg_id);
    if (!Number.isFinite(tcgId) || tcgId <= 0) return;
    try {
      const raw = localStorage.getItem(RESOLUTION_CACHE_KEY);
      const cache = raw ? JSON.parse(raw) : {};
      cache[row.card_id] = {
        ...(row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {}),
        tcg_id: tcgId,
        saved_at: Date.now(),
      };
      localStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(cache));
    } catch {}
    emit(tcgId);
  });
};

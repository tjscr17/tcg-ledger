// ============================================================================
// TCGCSV pricing client — talks to /api/tcgcsv (Vercel function in prod,
// Vite middleware in dev) to fetch the latest TCGPlayer market prices for
// One Piece TCG cards. Replaces PriceCharting for raw / market prices.
//
// Lookups are keyed on TCGPlayer's `productId` (the same int we already
// store as `tcg_id` on card_resolutions, populated historically by the
// PriceCharting bridge). Migration from PC to TCGCSV reuses that mapping
// directly — no new variant-resolution work needed for already-resolved
// cards.
//
// Caches the per-card snapshot in localStorage so a Collection view with
// hundreds of cards doesn't slam the proxy on every render. A tiny pub/sub
// (mirrors grading.js's onVariantResolved) lets consumers re-render when
// a previously-pending price lands.
// ============================================================================

const PRICE_CACHE_KEY = 'optcg:tcgcsv:prices:v1';
const PRICE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — TCGCSV refreshes daily, this is generous

// Bridge: PriceCharting historically resolved every card to a TCGPlayer
// `tcg-id`, cached in localStorage at this key. We read from it directly
// so Stage 2 of the TCGCSV migration has a card_id → productId map without
// rebuilding one from scratch. Once the TCGCSV-based variant resolver lands
// (Stage 3), this lookup will be supplemented (and eventually replaced).
const PC_TCG_ID_CACHE_KEY = 'optcg:pc:images:v1';

// Synchronous lookup: returns the TCGPlayer productId for a canonical
// card id, or null when we haven't resolved one yet. Falls back to the
// legacy OPTCG-style id if the canonical hasn't been cached.
export const getTcgId = (cardId, legacyId) => {
  if (!cardId && !legacyId) return null;
  try {
    const raw = localStorage.getItem(PC_TCG_ID_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    const hit = (cardId && cache[cardId]) || (legacyId && cache[legacyId]) || null;
    return hit ? Number(hit) : null;
  } catch {
    return null;
  }
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

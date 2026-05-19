// ============================================================================
// Card catalog & pricing — powered by OPTCGAPI (https://optcgapi.com)
// Free, no auth, refreshed daily by the maintainer.
//
// We hit four "all*" endpoints once on first load and merge:
//   - /api/allSetCards/      (booster sets OP01–OP15+)
//   - /api/allSTCards/       (structure decks ST01–ST28+)
//   - /api/allPromoCards/    (promos)
// Result is cached in localStorage for 24h so we don't spam their VPS.
//
// For price history we hit /api/sets/card/twoweeks/{id}/ on demand per card.
// ============================================================================

const API = 'https://optcgapi.com/api';
const CACHE_KEY = 'optcg:catalog:v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const HISTORY_PREFIX = 'optcg:history:';
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const fetchJSON = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
};

// Normalize one card response into our shape
const normalize = (raw, sourceType) => ({
  id: raw.card_set_id || raw.card_id,
  name: (raw.card_name || '').replace(/\s*\(\d+\)\s*$/, '').trim(),
  fullName: raw.card_name,
  setId: raw.set_id || (sourceType === 'promo' ? 'PROMO' : ''),
  setName: raw.set_name || (sourceType === 'promo' ? 'Promo' : ''),
  rarity: raw.rarity,
  type: raw.card_type,
  color: raw.card_color,
  cost: raw.card_cost,
  power: raw.card_power,
  life: raw.life,
  counter: raw.counter_amount,
  attribute: raw.attribute,
  subTypes: raw.sub_types,
  text: raw.card_text,
  marketPrice: Number(raw.market_price) || 0,
  inventoryPrice: Number(raw.inventory_price) || 0,
  imageUrl: raw.card_image,
  imageId: raw.card_image_id || raw.card_set_id || raw.card_id,
  isParallel: /\(Parallel\)|\(Alternate\)|_p\d/i.test(raw.card_name || '') || /_p\d/i.test(raw.card_image_id || ''),
  source: sourceType,
});

let catalogPromise = null;

export const loadCatalog = async ({ force = false } = {}) => {
  if (!force) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const { ts, cards } = JSON.parse(raw);
        if (Date.now() - ts < CACHE_TTL_MS && Array.isArray(cards) && cards.length > 0) {
          return cards;
        }
      }
    } catch {}
  }

  if (catalogPromise) return catalogPromise;

  catalogPromise = (async () => {
    const [sets, sts, promos] = await Promise.all([
      fetchJSON(`${API}/allSetCards/`).catch(() => []),
      fetchJSON(`${API}/allSTCards/`).catch(() => []),
      fetchJSON(`${API}/allPromoCards/`).catch(() => []),
    ]);

    const cards = [
      ...sets.map(c => normalize(c, 'set')),
      ...sts.map(c => normalize(c, 'starter')),
      ...promos.map(c => normalize(c, 'promo')),
    ].filter(c => c.id);

    // De-dupe (some endpoints overlap), keep the most recent
    const byKey = new Map();
    for (const c of cards) {
      const key = c.imageId || c.id;
      const existing = byKey.get(key);
      if (!existing || (c.marketPrice && !existing.marketPrice)) byKey.set(key, c);
    }

    const final = Array.from(byKey.values()).sort((a, b) => {
      if (a.setId !== b.setId) return (a.setId || '').localeCompare(b.setId || '');
      return (a.id || '').localeCompare(b.id || '');
    });

    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: final }));
    } catch {
      // localStorage might be full — strip down to essentials
      const slim = final.map(c => ({
        id: c.id, name: c.name, fullName: c.fullName, setId: c.setId, setName: c.setName,
        rarity: c.rarity, type: c.type, color: c.color, cost: c.cost, power: c.power,
        life: c.life, counter: c.counter, attribute: c.attribute, subTypes: c.subTypes,
        marketPrice: c.marketPrice, inventoryPrice: c.inventoryPrice,
        imageUrl: c.imageUrl, imageId: c.imageId, isParallel: c.isParallel, source: c.source,
      }));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: slim })); } catch {}
    }

    return final;
  })().finally(() => { catalogPromise = null; });

  return catalogPromise;
};

export const refreshCard = async (cardId) => {
  // Fetch fresh data for one card (used when opening detail drawer)
  try {
    const res = await fetchJSON(`${API}/sets/card/${cardId}/`);
    if (Array.isArray(res) && res.length > 0) {
      return res.map(c => normalize(c, 'set'));
    }
  } catch {}
  return [];
};

export const loadPriceHistory = async (cardId) => {
  try {
    const cached = localStorage.getItem(HISTORY_PREFIX + cardId);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < HISTORY_TTL_MS) return data;
    }
  } catch {}

  try {
    // Try set, then starter, then promo endpoints
    let data = null;
    for (const path of [
      `${API}/sets/card/twoweeks/${cardId}/`,
      `${API}/decks/card/twoweeks/${cardId}/`,
      `${API}/promos/card/twoweeks/${cardId}/`,
    ]) {
      try {
        const res = await fetchJSON(path);
        if (Array.isArray(res) && res.length > 0) { data = res; break; }
      } catch {}
    }
    if (!data) return [];

    const points = data
      .map(d => ({
        date: d.date_scraped || d.date || d.scrape_date,
        price: Number(d.market_price ?? d.inventory_price) || 0,
      }))
      .filter(p => p.date && p.price > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    try {
      localStorage.setItem(HISTORY_PREFIX + cardId, JSON.stringify({ ts: Date.now(), data: points }));
    } catch {}

    return points;
  } catch (e) {
    console.error(e);
    return [];
  }
};

export const groupBySet = (cards) => {
  const groups = new Map();
  for (const c of cards) {
    const key = c.setId || 'OTHER';
    if (!groups.has(key)) groups.set(key, { setId: key, setName: c.setName, cards: [] });
    groups.get(key).cards.push(c);
  }
  return Array.from(groups.values()).sort((a, b) => a.setId.localeCompare(b.setId));
};

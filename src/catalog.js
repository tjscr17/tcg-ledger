// ============================================================================
// Card catalog — Supabase `cards` table as the single source of truth.
//
// Switched 2026-06-22 from the TCGPlayer/TCGCSV-sourced catalog to the
// rebuilt relational catalog in the `ajpxzfhmyzzgarewijnr` Supabase project.
// Each catalog card now IS a row in public.cards (one row per printing),
// joined to public.sets for set name/code. Identity is the cards.id UUID —
// not the old TCGPlayer canonical-string scheme.
//
// What changed vs the TCGCSV era:
//   + Clean official data: canonical card_code (OP01-039), explicit
//     variant_key (base/p1/p2/r1...), real name/rarity/category, and a
//     working image_url on every printing.
//   + Identity is a stable UUID (card.id), shared with collected_cards.card_id
//     in the same DB — no string-canonical derivation.
//   − No pricing yet. The TCGCSV price feed is dropped; market/low/mid/high
//     are 0 until a new price source is wired (planned: self-tracked price
//     snapshots in the new DB). pricing.js reads stay graceful at 0.
//   − Attributes are no longer regex-detected from a sales name; the printing
//     is identified by variant_key directly.
//
// Loads all EN printings (source='bandai-official') once, 24h-cached in
// localStorage. ~4.5k rows, paginated 1000 at a time (PostgREST row cap).
// ============================================================================

import { createClient } from '@supabase/supabase-js';

// Dedicated read-only client for the public catalog. The catalog DB is a FIXED
// project (the rebuilt relational catalog) — intentionally hardcoded and NOT
// read from VITE_SUPABASE_*. Those vars drive storage.js's vault-scoped client
// (shared mode) and on Vercel may point at a different/older project; letting
// the catalog follow them caused empty results. cards/sets carry no vault_key
// and are world-readable via the public anon key (bundle-safe by design).
const CATALOG_URL = 'https://ajpxzfhmyzzgarewijnr.supabase.co';
const CATALOG_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqcHh6ZmhteXp6Z2FyZXdpam5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTM3MjQsImV4cCI6MjA5NDcyOTcyNH0.YQ4V0pxw1tpOiVe_d9nxL0UqbHR-eFPTjiybpd2O28o';
const catalogClient = createClient(CATALOG_URL, CATALOG_KEY);

const CACHE_KEY = 'optcg:catalog:v14-multitcg'; // v14: all TCGs, each card carries tcgCode/tcgName
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const LANGUAGE = 'EN'; // catalog is EN-West for now; other langs exist in DB
const PAGE = 1000; // PostgREST default max rows per request

const normSetToken = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Supabase cards row (joined to sets) → catalog card object. Keeps the field
// names the rest of the app already reads (displayId, setId, imageUrl, …) so
// consumers don't change; identity moves to the UUID `id`/`canonicalId`.
const normalize = (row, tcgNames = {}) => {
  const set = row.sets || {};
  const tcgCode = set.tcg_code || '';
  const variant = row.variant_key || 'base';
  const isBase = variant === 'base';
  // external_id (printing image filename): card_code, or card_code_pN/_rN.
  const eid = isBase ? (row.card_code || '') : `${row.card_code || ''}_${variant}`;
  const card = {
    id: row.id,                       // UUID — the identity
    canonicalId: row.id,              // identity used as stored card_id
    displayId: row.card_code || '',   // official number, e.g. OP01-039
    variantKey: variant,              // base / p1 / p2 / r1 ...
    name: row.name || '',
    fullName: isBase ? (row.name || '') : `${row.name || ''} (${variant})`,
    cleanName: row.name || '',
    setId: set.set_code || '',
    setName: set.name || '',
    setAbbreviation: set.set_code || '',
    tcgCode,                              // e.g. OP / RIFT / UA — for the TCG filter
    tcgName: tcgNames[tcgCode] || tcgCode,
    rarity: row.rarity || '',
    category: row.category || '',
    // Bandai art goes through the same-origin proxy (can't hotlink their CDN);
    // externally-sourced cards (e.g. tcgplayer) use their stored image_url directly.
    imageUrl: (row.source && row.source !== 'bandai-official' && row.image_url)
      ? row.image_url
      : (eid ? `/api/img?card=${encodeURIComponent(eid)}` : ''),
    tcgplayerUrl: '',
    // Pricing deferred — no source yet. Kept as 0 so price reads stay graceful.
    tcg_id: 0,
    marketPrice: 0, lowPrice: 0, midPrice: 0, highPrice: 0,
    // Attributes now come from variant_key, not name regex.
    attributes: isBase ? [] : [variant],
    source: row.source || 'bandai-official',
  };
  card.isParallel = /^p\d+$/.test(variant);
  card.isManga = false; // not distinguishable from variant_key alone (treatment map TBD)
  return card;
};

// Sort bucket: lower = earlier in the Search view's set groups.
const bucketOfSet = (setId) => {
  if (!setId) return 9;
  const norm = normSetToken(setId);
  if (/^OP\d+(RE|ANN)$/.test(norm)) return 2;
  if (/^OP\d+$/.test(norm)) return 1;
  if (/^EB\d*$/.test(norm) || /^PRB\d*$/.test(norm)) return 3;
  if (/^ST/.test(norm)) return 4;
  if (/^OPPR$/.test(norm) || /^P$/.test(norm) || /PROMO/.test(norm)) return 5;
  if (/^OPOT$/.test(norm)) return 6;
  return 9;
};

const numericPart = (setId) => parseInt(((setId || '').match(/(\d+)/) || [])[1] || '0', 10);

export const compareSets = (a, b) => {
  const ab = bucketOfSet(a.setId);
  const bb = bucketOfSet(b.setId);
  if (ab !== bb) return ab - bb;
  if (ab === 1 || ab === 2 || ab === 4) return numericPart(a.setId) - numericPart(b.setId);
  return (a.setId || '').localeCompare(b.setId || '');
};

// Variant ordering within one card number: base, then p1,p2,… then r1,r2,…
const variantRank = (v) => {
  if (!v || v === 'base') return 0;
  const m = /^([a-z])(\d+)$/.exec(v);
  if (!m) return 9000;
  const tier = m[1] === 'p' ? 1000 : m[1] === 'r' ? 2000 : 3000;
  return tier + (parseInt(m[2], 10) || 0);
};

// Full card order matching the official cardlist: set → card number → variant.
// displayId is zero-padded (OP01-001), so a string compare gives numeric order
// within a set; variantRank breaks ties so base precedes its parallels.
export const compareCards = (a, b) => {
  if (a.setId !== b.setId) return compareSets(a, b);
  const ad = a.displayId || '', bd = b.displayId || '';
  if (ad !== bd) return ad.localeCompare(bd);
  return variantRank(a.variantKey) - variantRank(b.variantKey);
};

// Group catalog cards by set for the Search view's set-grouped layout.
export const groupBySet = (cards) => {
  const groups = new Map();
  for (const c of cards) {
    const key = c.setId || 'OTHER';
    if (!groups.has(key)) groups.set(key, { setId: key, setName: c.setName, cards: [] });
    groups.get(key).cards.push(c);
  }
  return Array.from(groups.values()).sort(compareSets);
};

// ---------------------------------------------------------------------------
// Loader + cache
// ---------------------------------------------------------------------------

const readCachedCatalog = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, cards } = JSON.parse(raw);
    if (!Array.isArray(cards) || cards.length === 0) return null;
    return { age: Date.now() - (ts || 0), cards };
  } catch { return null; }
};

let catalogPromise = null;

export const loadCatalog = async ({ force = false } = {}) => {
  if (!force) {
    const cached = readCachedCatalog();
    if (cached) {
      if (cached.age >= CACHE_TTL_MS) {
        revalidateCatalog().catch((e) => console.warn('catalog revalidate failed', e));
      }
      return cached.cards;
    }
  }
  return revalidateCatalog();
};

// Page through every EN printing across ALL TCGs (PostgREST caps a single
// request at ~1000 rows, so we range-paginate until a short page returns).
// No source filter: One Piece (bandai-official/tcgplayer), Riftbound
// (riftcodex), Union Arena (unionarena-na), etc. all come through. Each row
// carries its set's tcg_code so the UI can filter by game.
const fetchAllCards = async () => {
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await catalogClient
      .from('cards')
      .select('id,card_code,variant_key,name,rarity,category,image_url,source,sets!inner(set_code,name,language,tcg_code)')
      .eq('sets.language', LANGUAGE)
      .order('card_code', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[catalog] Supabase query failed', error); throw new Error(`catalog query failed: ${error.message}`); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
};

// tcg_code -> display name (One Piece Card Game, Riftbound, …). Small table.
const fetchTcgNames = async () => {
  const { data, error } = await catalogClient.from('tcgs').select('tcg_code,name');
  if (error) { console.warn('[catalog] tcgs fetch failed', error); return {}; }
  const map = {};
  for (const t of (data || [])) map[t.tcg_code] = t.name;
  return map;
};

// Per-TCG rarity lookup for the rarity filter: { [tcg_code]: [{code,label,sort_order}] }.
// Cached 24h in localStorage. Falls back to {} so callers derive distinct
// rarities from the catalog when a TCG has no rows yet.
const RARITIES_CACHE_KEY = 'optcg:rarities:v1';
export const loadRarities = async ({ force = false } = {}) => {
  if (!force) {
    try {
      const raw = localStorage.getItem(RARITIES_CACHE_KEY);
      if (raw) {
        const { ts, byTcg } = JSON.parse(raw);
        if (byTcg && Date.now() - (ts || 0) < CACHE_TTL_MS) return byTcg;
      }
    } catch {}
  }
  const { data, error } = await catalogClient
    .from('rarities').select('tcg_code,code,label,sort_order').order('sort_order', { ascending: true });
  if (error) { console.warn('[catalog] rarities fetch failed', error); return {}; }
  const byTcg = {};
  for (const r of (data || [])) {
    (byTcg[r.tcg_code] ||= []).push({ code: r.code, label: r.label || r.code, sort_order: r.sort_order ?? 0 });
  }
  try { localStorage.setItem(RARITIES_CACHE_KEY, JSON.stringify({ ts: Date.now(), byTcg })); } catch {}
  return byTcg;
};

const revalidateCatalog = async () => {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const [rows, tcgNames] = await Promise.all([fetchAllCards(), fetchTcgNames()]);
    const cards = rows.map((r) => normalize(r, tcgNames)).filter(c => c.id && c.displayId);
    const final = cards.sort(compareCards);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: final }));
    } catch {
      // localStorage full — store a slim shape (drop the few non-essential fields).
      const slim = final.map(c => ({
        id: c.id, canonicalId: c.canonicalId, displayId: c.displayId, variantKey: c.variantKey,
        name: c.name, fullName: c.fullName, cleanName: c.cleanName,
        setId: c.setId, setName: c.setName, setAbbreviation: c.setAbbreviation,
        tcgCode: c.tcgCode, tcgName: c.tcgName,
        rarity: c.rarity, category: c.category, imageUrl: c.imageUrl,
        tcg_id: 0, attributes: c.attributes, isParallel: c.isParallel, isManga: c.isManga,
        source: c.source,
      }));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: slim })); } catch {}
    }
    return final;
  })().finally(() => { catalogPromise = null; });
  return catalogPromise;
};

// ---------------------------------------------------------------------------
// Pre-errata twins. User marks a card as having a pre-errata printing; the
// catalog then exposes both versions as separate entries so they can be logged
// independently. Persisted in localStorage; survives catalog cache bumps.
// (Identity for the twin is the base UUID suffixed with __pre-errata.)
// ---------------------------------------------------------------------------

const ERRATA_KEY = 'optcg:errata:v1';
const ERRATA_SUFFIX = '__pre-errata';

const readErrataSet = () => {
  try {
    const raw = localStorage.getItem(ERRATA_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
};

export const hasPreErrata = (cardId) => readErrataSet().has(cardId);

export const togglePreErrata = (cardId) => {
  const set = readErrataSet();
  if (set.has(cardId)) set.delete(cardId); else set.add(cardId);
  try { localStorage.setItem(ERRATA_KEY, JSON.stringify([...set])); } catch {}
  return set.has(cardId);
};

// ---------------------------------------------------------------------------
// Add-from-alternate-source: when the official Bandai cardlist is missing a
// printing (tournament/promo cards, etc.), look it up on TCGplayer (via the
// TCGCSV proxy) and add it to the catalog as source='tcgplayer'. RLS lets the
// anon key INSERT only source='tcgplayer' rows; official cards stay protected.
// ---------------------------------------------------------------------------

// Search TCGplayer for every printing of a card number (e.g. "OP09-004").
export const searchAlternateSource = async (number) => {
  const n = String(number || '').trim();
  if (!n) return [];
  const res = await fetch(`/api/tcgcsv?number=${encodeURIComponent(n)}`);
  if (!res.ok) throw new Error(`TCGplayer lookup failed (${res.status})`);
  const body = await res.json();
  return Array.isArray(body?.products) ? body.products : [];
};

// Derive a stable, descriptive variant_key slug from a TCGplayer product name,
// e.g. "Killer (CS 2023 Top Players Pack) [Winner]" -> "cs-2023-top-players-pack-winner".
export const deriveVariantKey = (productName) => {
  const parts = [...String(productName || '').matchAll(/[([]([^)\]]+)[)\]]/g)].map(m => m[1]);
  const slug = (parts.join(' ') || 'promo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return slug || 'promo';
};

// Insert a missing printing. Anchors the home set from the card's base printing.
// Returns the raw inserted row; caller should reload the catalog to pick it up.
export const addExternalCard = async ({ cardCode, variantKey, name, rarity, imageUrl, externalId, category }) => {
  const code = String(cardCode || '').trim();
  const variant = String(variantKey || '').trim().toLowerCase();
  if (!code) throw new Error('A card number is required.');
  if (!variant) throw new Error('A variant label is required.');
  const { data: base, error: bErr } = await catalogClient.from('cards')
    .select('set_id, category').eq('card_code', code).eq('variant_key', 'base').limit(1).maybeSingle();
  if (bErr) throw new Error(bErr.message);
  if (!base) throw new Error(`No base printing of ${code} in the catalog to anchor its set.`);
  const row = {
    set_id: base.set_id,
    card_code: code,
    variant_key: variant,
    name: name || '',
    rarity: rarity || null,
    category: category || base.category || null,
    image_url: imageUrl || null,
    external_id: externalId != null ? String(externalId) : null,
    source: 'tcgplayer',
  };
  const { data, error } = await catalogClient.from('cards').insert(row).select().single();
  if (error) throw new Error(error.message);
  try { localStorage.removeItem(CACHE_KEY); } catch {} // bust cache so it shows on reload
  return data;
};

export const augmentWithErrata = (catalog) => {
  const set = readErrataSet();
  if (set.size === 0) return catalog;
  const twins = [];
  for (const c of catalog) {
    if (!set.has(c.id)) continue;
    twins.push({
      ...c,
      id: `${c.id}${ERRATA_SUFFIX}`,
      canonicalId: `${c.id}${ERRATA_SUFFIX}`,
      variant: 'Pre-errata',
      variantTag: 'pre-errata',
    });
  }
  return twins.length > 0 ? [...catalog, ...twins] : catalog;
};

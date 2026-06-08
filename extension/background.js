// OPTCG Ledger 130point sync — background service worker (manifest v3).
//
// Architecture: this script is the orchestrator. The popup sends a SYNC
// message; we pull the list of cards the user owns from Supabase, query
// 130point.com for each unique displayId (with the user's existing cookies
// and Cloudflare clearance), parse the response with parser.js, and upsert
// the resulting rows into the `sales` table.
//
// Why a service worker (not Vercel) does the fetching: 130point is behind
// Cloudflare; AWS / Vercel IPs are flagged as datacenter traffic and bounced
// off the JS challenge. The user's browser already holds a valid
// cf_clearance cookie from normal browsing, so fetch() from the extension's
// origin reuses it automatically.

import { parseSearchResultsHtml } from './parser.js';

const SEARCH_URL = (q) =>
  `https://130point.com/api/search/html?q=${encodeURIComponent(q)}&sort=recent&mp=all`;

// Polite per-query delay so we look like a person clicking through pages, not
// a script. 130point's pages are heavy on the wire so spacing helps anyway.
const QUERY_DELAY_MS = 1200;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Pull current settings from chrome.storage.local. The popup writes these
// once during initial setup.
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || null;
}

// REST helpers — Supabase exposes PostgREST over /rest/v1. We use the
// vault_key as the partition column on every row (same convention as the
// webapp's Supabase storage adapter).

function supabaseHeaders(s) {
  return {
    'apikey': s.supabaseKey,
    'Authorization': `Bearer ${s.supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

async function listEntries(s) {
  const url = `${s.supabaseUrl}/rest/v1/entries?select=card_id&vault_key=eq.${encodeURIComponent(s.vaultKey)}`;
  const r = await fetch(url, { headers: supabaseHeaders(s) });
  if (!r.ok) throw new Error(`Supabase entries fetch failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function insertSale(s, sale) {
  // PostgREST: POST with on_conflict to upsert. We dedupe on
  // (vault_key, listing_url) so re-syncing the same query doesn't write
  // duplicate rows. Sales without listing_url don't have a stable identity,
  // so we accept potential dupes for those rare cases.
  const url = `${s.supabaseUrl}/rest/v1/sales?on_conflict=vault_key,listing_url`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...supabaseHeaders(s), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(sale),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase insert failed: ${r.status} ${body}`);
  }
}

// Pull one search page from 130point, parse, return normalized sales.
async function fetchSalesForQuery(query) {
  const url = SEARCH_URL(query);
  const r = await fetch(url, {
    credentials: 'include',     // include cf_clearance + session cookies
    headers: {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'referer': 'https://130point.com/search',
    },
  });
  if (!r.ok) throw new Error(`130point fetch ${r.status} for q=${query}`);
  const html = await r.text();
  // Service workers don't have DOMParser built-in until recent Chrome — use
  // it via globalThis (Chrome 119+ has it). Fall back to regex if absent.
  if (typeof DOMParser === 'undefined') {
    throw new Error('DOMParser not available in this service worker. Use Chrome 119+.');
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return parseSearchResultsHtml(doc);
}

// Convert a parser-output sale into a Supabase `sales` row. Skips
// non-matching / bundle / non-USD rows by returning null.
function toSalesRow(s, parsed, queryCardId) {
  if (!parsed.primary_card_id) return null;        // no card-id in title — drop
  if (parsed.card_ids.length > 1) return null;     // bundle — drop
  if (parsed.primary_card_id !== queryCardId) return null; // wrong card hit by search
  if (parsed.currency !== 'USD') return null;      // FX deferred; USD-only for now
  if (!parsed.sale_date) return null;              // need a date for windowing

  return {
    vault_key: s.vaultKey,
    card_id: parsed.primary_canonical_id || parsed.primary_card_id,
    grading_company: parsed.grading_company,
    grade: parsed.grade,
    bgs_black: parsed.bgs_black,
    sale_date: parsed.sale_date,
    sale_price: parsed.sale_price,
    currency: parsed.currency,
    marketplace: parsed.marketplace,
    listing_url: parsed.listing_url,
    listing_title: parsed.listing_title,
    notes: parsed.original_price ? `listed at $${parsed.original_price}; ${parsed.sale_type || ''}`.trim() : (parsed.sale_type || null),
    source: '130point-scrape',
  };
}

// Sync orchestrator — called by the popup. Reports progress via runtime
// messages so the popup can show a live counter.
async function runSync() {
  const settings = await getSettings();
  if (!settings) throw new Error('Configure Supabase URL + key + vault first.');

  const entries = await listEntries(settings);
  const uniqueDisplayIds = Array.from(new Set(
    entries
      .map(e => (e.card_id || '').replace(/-(parallel|manga|pre-errata|.*-.*)$/i, ''))
      .filter(Boolean)
  )).sort();

  const total = uniqueDisplayIds.length;
  postProgress({ phase: 'started', total, done: 0, inserted: 0 });

  let inserted = 0;
  const errors = [];
  for (let i = 0; i < uniqueDisplayIds.length; i++) {
    const cardId = uniqueDisplayIds[i];
    try {
      const { sales: parsedSales } = await fetchSalesForQuery(`${cardId} one piece`);
      for (const ps of parsedSales) {
        const row = toSalesRow(settings, ps, cardId);
        if (!row) continue;
        await insertSale(settings, row);
        inserted++;
      }
    } catch (e) {
      console.warn('[sync] error for', cardId, e);
      errors.push({ cardId, message: e.message || String(e) });
    }
    postProgress({ phase: 'progress', total, done: i + 1, inserted, current: cardId });
    await sleep(QUERY_DELAY_MS);
  }

  postProgress({ phase: 'done', total, done: total, inserted, errors });
  return { inserted, errors };
}

function postProgress(msg) {
  // Service workers can't directly update the popup DOM — broadcast.
  chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', payload: msg }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'RUN_SYNC') {
    runSync()
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // keep the channel open for async
  }
  if (message?.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
});

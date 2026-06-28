// Ingest the Union Arena (UA) NA catalog by scraping the official Bandai
// cardlist, into Supabase sets/cards/rarities.
//
//   node tools/ingest/union-arena.mjs
//
// Mechanism (same Bandai engine as One Piece):
//   - GET /na/cardlist/ exposes a `series` <select> of numeric product ids
//     (591101 = UE01BT, …). The card grid is server-rendered only via a POST.
//   - POST /na/cardlist/index.php?search=true  body: series=<id>  -> all cards
//     for that product as <li class="cardImgCol"> tiles carrying card_no, name
//     (img alt) and image path. No CSRF token; results are unpaginated.
//   - The grid has no rarity, but the same endpoint filters by rare[]=SR|R|U|
//     C|UR|SP, so 6 extra POSTs per product map card_no -> rarity cheaply
//     (vs a detail fetch per card).
//   - Alt-art printings carry a _pN suffix in card_no (…BLC-1-004_p1) and are
//     already in the default grid -> variant_key from that suffix.
//
// Minimal mapping (no extra classification):
//   set_code   = product code (UE01BT) from the card_no prefix
//   card_code  = card_no without the _pN suffix (e.g. UE01BT/BLC-1-001)
//   variant_key= pN from the suffix, else 'base'
//   external_id= full card_no            source = 'unionarena-na'
//   image_url  = absolute UA CDN url (hotlinkable; no proxy needed)

import { createClient } from '@supabase/supabase-js';

const SUPA_URL = 'https://ajpxzfhmyzzgarewijnr.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqcHh6ZmhteXp6Z2FyZXdpam5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTM3MjQsImV4cCI6MjA5NDcyOTcyNH0.YQ4V0pxw1tpOiVe_d9nxL0UqbHR-eFPTjiybpd2O28o';
const TCG = 'UA';
const SOURCE = 'unionarena-na';
const SITE = 'https://www.unionarena-tcg.com';
const LIST = `${SITE}/na/cardlist/`;
const SEARCH = `${SITE}/na/cardlist/index.php?search=true`;
const RARITIES = ['SR', 'R', 'U', 'C', 'UR', 'SP'];
const RARITY_ORDER = ['C', 'U', 'R', 'SR', 'SP', 'UR']; // common -> rare, for the filter
const UA_HDRS = { 'User-Agent': 'tcg-ledger catalog sync (personal)', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' };
const DELAY_MS = 150;

const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(url) {
  const r = await fetch(url, { headers: UA_HDRS });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function postSearch(body) {
  const r = await fetch(SEARCH, {
    method: 'POST',
    headers: { ...UA_HDRS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!r.ok) throw new Error(`POST ${JSON.stringify(body)} -> ${r.status}`);
  await sleep(DELAY_MS);
  return r.text();
}

// Each tile: card_no (href + alt prefix), name (alt remainder), image data-src.
function parseTiles(html) {
  const out = [];
  const re = /card_no=([^"&]+)"[^>]*>\s*<img[^>]*data-src="([^"]+)"[^>]*alt="([^"]*)"/g;
  for (const m of html.matchAll(re)) {
    const cardNo = m[1];
    const img = m[2];
    const alt = m[3];
    const name = alt.replace(/^\S+\s+/, '').trim(); // drop the leading card_no token
    out.push({ cardNo, img, name });
  }
  return out;
}
const searchCount = (html) => {
  const m = /<span class="searchCount">(\d+)<\/span>/.exec(html);
  return m ? parseInt(m[1], 10) : null;
};

function parseCardNo(cardNo) {
  const vm = /_(p\d+)$/i.exec(cardNo);
  const variant = vm ? vm[1].toLowerCase() : 'base';
  const baseNo = vm ? cardNo.slice(0, vm.index) : cardNo;
  const product = cardNo.split('/')[0] || '';
  return { product, baseNo, variant };
}

async function main() {
  const { count, error: cErr } = await supa
    .from('cards').select('id', { count: 'exact', head: true }).eq('source', SOURCE);
  if (cErr) throw new Error(`precheck failed: ${cErr.message}`);
  if (count > 0) {
    console.error(`\n${count} ${SOURCE} cards already exist. Clear them first (admin):`);
    console.error(`  delete from cards where source='${SOURCE}';`);
    console.error(`  delete from sets where tcg_code='${TCG}';`);
    console.error(`  delete from rarities where tcg_code='${TCG}';`);
    process.exit(1);
  }

  // 1) Series ids + labels from the cardlist page.
  const listHtml = await getHtml(LIST);
  const series = [...listHtml.matchAll(/<option[^>]*value="(\d{6})"[^>]*>([^<]*)</g)]
    .map((m) => ({ id: m[1], label: m[2].trim() }));
  console.log(`Found ${series.length} products.`);
  // set_code -> clean name, from the "[CODE]" in each label.
  const setName = new Map();
  for (const s of series) {
    const m = /\[([A-Z0-9]+)(?:\s+\w+)?\]/.exec(s.label);
    if (m) { const code = m[1]; const nm = s.label.replace(/\s*\[[^\]]*\]\s*$/, '').trim(); if (!setName.has(code)) setName.set(code, nm); }
  }

  // 2) Scrape every product: full grid + per-rarity maps.
  const byCardNo = new Map(); // full card_no -> { name, img, product }
  const rarityOf = new Map(); // full card_no -> rarity
  let pageWarnings = 0;
  for (const s of series) {
    try {
      const full = await postSearch({ series: s.id });
      const tiles = parseTiles(full);
      const cnt = searchCount(full);
      if (cnt != null && tiles.length < cnt) { pageWarnings++; console.warn(`  ${s.label}: parsed ${tiles.length}/${cnt} (possible pagination)`); }
      for (const t of tiles) if (!byCardNo.has(t.cardNo)) byCardNo.set(t.cardNo, t);
      for (const rv of RARITIES) {
        const h = await postSearch({ series: s.id, 'rare[]': rv });
        for (const t of parseTiles(h)) if (!rarityOf.has(t.cardNo)) rarityOf.set(t.cardNo, rv);
      }
      process.stdout.write(`\r  ${s.id} ${s.label.slice(0, 38).padEnd(38)} cards=${byCardNo.size}   `);
    } catch (e) {
      console.warn(`\n  product ${s.id} failed: ${e.message}`);
    }
  }
  process.stdout.write('\n');

  // 3) Build rows.
  const setCodes = new Set();
  const rarities = new Set();
  let noRarity = 0;
  const cardsRaw = [];
  for (const [cardNo, t] of byCardNo) {
    const { product, baseNo, variant } = parseCardNo(cardNo);
    if (!product) continue;
    setCodes.add(product);
    const rarity = rarityOf.get(cardNo) || null;
    if (rarity) rarities.add(rarity); else noRarity++;
    cardsRaw.push({
      setCode: product,
      card_code: baseNo,
      variant_key: variant,
      name: t.name || null,
      rarity,
      image_url: t.img.startsWith('http') ? t.img : `${SITE}${t.img}`,
      external_id: cardNo,
    });
  }
  console.log(`Collected ${cardsRaw.length} cards across ${setCodes.size} sets (${noRarity} without a rarity).`);

  // 4) Insert sets, then cards, then rarities.
  const setRows = [...setCodes].sort().map((code) => ({
    set_code: code, tcg_code: TCG, name: setName.get(code) || code, language: 'EN',
  }));
  const { data: insertedSets, error: sErr } = await supa.from('sets').insert(setRows).select('id,set_code');
  if (sErr) throw new Error(`set insert failed: ${sErr.message}`);
  const setIdByCode = new Map(insertedSets.map((r) => [r.set_code, r.id]));

  const cardRows = cardsRaw
    .map((c) => ({
      set_id: setIdByCode.get(c.setCode),
      card_code: c.card_code, variant_key: c.variant_key, name: c.name,
      rarity: c.rarity, image_url: c.image_url, external_id: c.external_id, source: SOURCE,
    }))
    .filter((c) => c.set_id);

  for (let i = 0; i < cardRows.length; i += 500) {
    const { error } = await supa.from('cards').insert(cardRows.slice(i, i + 500));
    if (error) throw new Error(`card insert failed at ${i}: ${error.message}`);
    process.stdout.write(`\r  inserted ${Math.min(i + 500, cardRows.length)}/${cardRows.length}   `);
  }
  process.stdout.write('\n');

  const rarityRows = [...rarities].map((code) => {
    const idx = RARITY_ORDER.indexOf(code);
    return { tcg_code: TCG, code, label: code, sort_order: idx === -1 ? 999 : idx };
  });
  if (rarityRows.length) {
    const { error } = await supa.from('rarities').insert(rarityRows);
    if (error) throw new Error(`rarity insert failed: ${error.message}`);
  }

  console.log(`\nDone. sets=${insertedSets.length} cards=${cardRows.length} rarities=${rarityRows.length}${pageWarnings ? ` (⚠ ${pageWarnings} products may have paginated)` : ''}`);
  console.log(`rarities: ${[...rarities].join(', ')}`);
}

main().catch((e) => { console.error('\nINGEST FAILED:', e.message); process.exit(1); });

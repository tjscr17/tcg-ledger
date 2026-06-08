// Parse 130point's /api/search/html response into normalized sale records.
//
// Written as a classic script (no ES module syntax) so it can be loaded both
// as a content script via the manifest's `content_scripts` directive AND
// via chrome.scripting.executeScript({files}). Exposes its API on
// `self.OPTCG_LEDGER` so the content-script side can call it.
//
// Each result in the HTML is:
//   <a data-sold-result data-sold-index="N" href="https://ebay.com/itm/...">
//     <img alt="Title text" src="image url">            <-- card image
//     <img alt="eBay" src="/brand/merchants/ebay.png">  <-- marketplace logo
//     <p class="font-bold ...">Title text</p>            <-- title
//     <p data-original-price-amount="X" ...>...</p>     <-- listed (line-through)
//     <p data-price-amount="X" data-price-currency=...>  <-- ACTUAL sold price
//     <p>Fixed Price | Best Offer Accepted | Auction</p>
//     <p>[<span>N bids</span> ·] <span data-result-end-time="ISO"></span></p>
//   </a>
//
// We pull from `data-*` attributes (clean numerics + ISO timestamps) instead
// of parsing display strings — robust against 130point reformatting their
// display layer.

(function (root) {
  const CARD_ID_RE = /\b(?:OP|EB|ST|PRB)\d{2}-[A-Z]?\d{2,3}[A-Z]?\b/gi;
  const GRADE_RE = /\b(PSA|BGS|CGC|SGC)\s*(\d+(?:\.\d+)?)\b/i;

  function detectVariant(title) {
    const t = title.toUpperCase();
    const isParallel = /\bPARALLEL\b/.test(t);
    const isManga = /\bMANGA\s+(RARE|PARALLEL|VARIANT)\b/.test(t) ||
                    /\b(RARE|PARALLEL|VARIANT)\s+MANGA\b/.test(t);
    const isPreErrata = /\bPRE[- ]ERRATA\b/.test(t);
    const parts = [];
    if (isManga) parts.push('manga');
    if (isParallel) parts.push('parallel');
    if (isPreErrata) parts.push('pre-errata');
    return parts.sort().join('-') || null;
  }

  function canonicalIdFor(displayId, title) {
    const variant = detectVariant(title);
    return variant ? `${displayId}-${variant}` : displayId;
  }

  function cardIdsFromTitle(title) {
    const seen = new Set();
    const ids = [];
    let m;
    CARD_ID_RE.lastIndex = 0;
    while ((m = CARD_ID_RE.exec(title)) !== null) {
      const id = m[0].toUpperCase();
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
  }

  function gradeFromTitle(title) {
    const m = title.match(GRADE_RE);
    if (!m) return { grading_company: null, grade: null, bgs_black: false };
    const company = m[1].toUpperCase();
    const grade = Number(m[2]);
    const bgs_black = company === 'BGS' && /BLACK\s+LABEL/i.test(title);
    return { grading_company: company, grade, bgs_black };
  }

  function parseSearchResultsHtml(doc) {
    const container = doc.querySelector('[data-search-results-fragment]');
    const total_results = Number(container?.getAttribute('data-total-results') || 0);
    const nodes = doc.querySelectorAll('[data-sold-result]');
    const sales = [];
    for (const a of nodes) {
      try {
        const listing_url = a.getAttribute('href') || null;
        const merchantImg = a.querySelector('img[alt][src*="/brand/merchants/"]');
        const marketplace = merchantImg?.getAttribute('alt') || 'unknown';

        let image_url = null;
        for (const img of a.querySelectorAll('img')) {
          if (img === merchantImg) continue;
          image_url = img.getAttribute('src') || null;
          break;
        }

        const titleEl = a.querySelector('p.font-bold');
        const listing_title = (titleEl?.textContent || '').trim();

        const soldP = a.querySelector('p[data-price-amount]:not([data-original-price-amount])');
        if (!soldP) continue;
        const sale_price = Number(soldP.getAttribute('data-price-amount'));
        const currency = soldP.getAttribute('data-price-currency') || 'USD';
        if (!Number.isFinite(sale_price) || sale_price <= 0) continue;

        const origP = a.querySelector('p[data-original-price-amount]');
        const original_price = origP ? Number(origP.getAttribute('data-original-price-amount')) : null;

        let sale_type = null;
        for (const p of a.querySelectorAll('p')) {
          const txt = (p.textContent || '').trim();
          if (/^(Fixed Price|Best Offer Accepted|Auction)$/.test(txt)) {
            sale_type = txt;
            break;
          }
        }

        const endEl = a.querySelector('[data-result-end-time]');
        const sale_datetime = endEl?.getAttribute('data-result-end-time') || null;
        const sale_date = sale_datetime ? sale_datetime.slice(0, 10) : null;

        const card_ids = cardIdsFromTitle(listing_title);
        const primary_card_id = card_ids[0] || null;
        const primary_canonical_id = primary_card_id ? canonicalIdFor(primary_card_id, listing_title) : null;
        const { grading_company, grade, bgs_black } = gradeFromTitle(listing_title);

        sales.push({
          marketplace,
          listing_url,
          listing_title,
          image_url,
          sale_price,
          currency,
          original_price,
          sale_type,
          sale_date,
          sale_datetime,
          card_ids,
          primary_card_id,
          primary_canonical_id,
          grading_company,
          grade,
          bgs_black,
        });
      } catch (e) {
        console.warn('[parser] failed to parse result', e);
      }
    }
    return { sales, total_results };
  }

  root.OPTCG_LEDGER = root.OPTCG_LEDGER || {};
  root.OPTCG_LEDGER.parseSearchResultsHtml = parseSearchResultsHtml;
})(typeof self !== 'undefined' ? self : globalThis);

// Parse 130point's /api/search/html response into normalized sale records.
//
// Each result in the HTML is:
//   <a data-sold-result data-sold-index="N" href="https://ebay.com/itm/...">
//     <img alt="Title text" src="image url">           <-- image
//     <img alt="eBay" src="/brand/merchants/ebay.png"> <-- marketplace logo
//     <p class="font-bold ...">Title text</p>           <-- title
//     <p data-original-price-amount="X" data-original-price-currency="USD">
//       <span data-original-price-display>$X USD</span>      <-- listed price (line-through)
//     </p>
//     <p data-price-amount="X" data-price-currency="USD">
//       <span data-price-display>$X USD</span>               <-- ACTUAL sold price
//     </p>
//     <p>Fixed Price | Best Offer Accepted | Auction</p>     <-- sale type
//     <p>
//       [<span>N bids</span> ·] <span data-result-end-time="ISO datetime"></span>
//     </p>
//   </a>
//
// We extract from `data-*` attributes (clean numerics + ISO timestamps) rather
// than parsing display strings ($1,700.00 USD → 1700) — robust against
// 130point reformatting their display layer.

// Card-ID regex covering current OP TCG set prefixes:
//   OP\d{2}-\w{2,4}    base sets:           OP01-016, OP01-SP01
//   EB\d{2}-\w{2,4}    extra boosters:      EB01-001
//   ST\d{2}-\w{2,4}    starter decks:       ST01-001
//   PRB\d{2}-\w{2,4}   premium boosters:    PRB01-005
// Greedy on the right (`\w{2,4}`) so SP01 / 018a etc. are captured.
const CARD_ID_RE = /\b(?:OP|EB|ST|PRB)\d{2}-[A-Z]?\d{2,3}[A-Z]?\b/gi;

// Grading-co + grade detection. We accept PSA / BGS / CGC / SGC followed by a
// numeric grade (.5 step allowed). Order matters — "PSA 10" beats "10" alone.
const GRADE_RE = /\b(PSA|BGS|CGC|SGC)\s*(\d+(?:\.\d+)?)\b/i;

// Variant detection — title keywords that suggest a non-base printing. Keep
// these strict so we don't mis-classify a generic "Manga" mention (the whole
// game is "One Piece Manga TCG") as the manga-rare variant.
function detectVariant(title) {
  const t = title.toUpperCase();
  const isParallel = /\bPARALLEL\b/.test(t);
  const isManga    = /\bMANGA\s+(RARE|PARALLEL|VARIANT)\b/.test(t) ||
                     /\b(RARE|PARALLEL|VARIANT)\s+MANGA\b/.test(t);
  const isPreErrata = /\bPRE[- ]ERRATA\b/.test(t);
  const parts = [];
  if (isManga) parts.push('manga');
  if (isParallel) parts.push('parallel');
  if (isPreErrata) parts.push('pre-errata');
  return parts.sort().join('-') || null;
}

// Build a canonical card_id matching the app's convention:
//   <displayId> for base, or <displayId>-<sorted variant tag>.
function canonicalIdFor(displayId, title) {
  const variant = detectVariant(title);
  return variant ? `${displayId}-${variant}` : displayId;
}

// Extract every distinct card displayId from a title, in order. Bundles
// (two or more distinct IDs) are returned so the caller can choose to skip
// them — a $1,700 sale of three cards in one listing is noise for any
// single-card price estimator.
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

// Parse a 130point search-results HTML fragment into an array of normalized
// sales. Uses DOMParser (available in extension service workers via
// `globalThis` polyfill; here we accept a Document so the caller can decide).
//
// Inputs:
//   doc — Document containing the fragment (from DOMParser)
// Outputs:
//   sales[] — each shaped like {
//     marketplace, listing_url, listing_title, image_url,
//     sale_price (number), currency,
//     original_price (number|null),
//     sale_type ('Fixed Price' | 'Best Offer Accepted' | 'Auction'),
//     sale_date (ISO date YYYY-MM-DD), sale_datetime (ISO),
//     bid_count (number|null),
//     card_ids[] — every OP card-ID found in title (so caller can skip bundles),
//     primary_card_id, primary_canonical_id (with variant suffix),
//     grading_company, grade, bgs_black,
//   }
//   total_results — int from data-total-results, useful for paging
export function parseSearchResultsHtml(doc) {
  const container = doc.querySelector('[data-search-results-fragment]');
  const total_results = Number(container?.getAttribute('data-total-results') || 0);
  const nodes = doc.querySelectorAll('[data-sold-result]');
  const sales = [];
  for (const a of nodes) {
    try {
      const listing_url = a.getAttribute('href') || null;
      // Marketplace logo: <img alt="eBay" src="/brand/merchants/ebay.png">.
      // We pull alt because the basename can change (`ebay.png` → `ebay-v2.png`)
      // but alt stays human-readable.
      const merchantImg = a.querySelector('img[alt][src*="/brand/merchants/"]');
      const marketplace = merchantImg?.getAttribute('alt') || 'unknown';

      // The big art image is the first <img> that ISN'T the merchant logo.
      let image_url = null;
      for (const img of a.querySelectorAll('img')) {
        if (img === merchantImg) continue;
        image_url = img.getAttribute('src') || null;
        break;
      }

      // Title — the bold <p> just before the price block.
      const titleEl = a.querySelector('p.font-bold');
      const listing_title = (titleEl?.textContent || '').trim();

      // Sold price — the <p data-price-amount> (NOT data-original-price-amount,
      // which is the line-through asking price).
      const soldP = a.querySelector('p[data-price-amount]:not([data-original-price-amount])');
      if (!soldP) continue;
      const sale_price = Number(soldP.getAttribute('data-price-amount'));
      const currency = soldP.getAttribute('data-price-currency') || 'USD';
      if (!Number.isFinite(sale_price) || sale_price <= 0) continue;

      // Original ask (optional).
      const origP = a.querySelector('p[data-original-price-amount]');
      const original_price = origP ? Number(origP.getAttribute('data-original-price-amount')) : null;

      // Sale type label — the small <p> after the price block whose text is
      // one of "Fixed Price" / "Best Offer Accepted" / "Auction". We pick
      // the first <p> not bolded after the prices.
      let sale_type = null;
      const tertiaryPs = a.querySelectorAll('p.block.text-\\[var\\(--text-tertiary\\)\\], p.mt-1.block');
      for (const p of tertiaryPs) {
        const txt = (p.textContent || '').trim();
        if (/^(Fixed Price|Best Offer Accepted|Auction)$/.test(txt)) {
          sale_type = txt;
          break;
        }
      }
      if (!sale_type) {
        // Fallback — any <p> whose only text is the label.
        for (const p of a.querySelectorAll('p')) {
          const txt = (p.textContent || '').trim();
          if (/^(Fixed Price|Best Offer Accepted|Auction)$/.test(txt)) { sale_type = txt; break; }
        }
      }

      // End time + optional bid count.
      const endEl = a.querySelector('[data-result-end-time]');
      const sale_datetime = endEl?.getAttribute('data-result-end-time') || null;
      const sale_date = sale_datetime ? sale_datetime.slice(0, 10) : null;
      const bidEl = a.querySelector('span.text-\\[var\\(--text-orange\\)\\]');
      const bidMatch = bidEl?.textContent?.match(/(\d+)\s+bids?/i);
      const bid_count = bidMatch ? Number(bidMatch[1]) : null;

      // Title → card identification.
      const card_ids = cardIdsFromTitle(listing_title);
      const primary_card_id = card_ids[0] || null;
      const primary_canonical_id = primary_card_id ? canonicalIdFor(primary_card_id, listing_title) : null;

      // Title → grade.
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
        bid_count,
        card_ids,
        primary_card_id,
        primary_canonical_id,
        grading_company,
        grade,
        bgs_black,
      });
    } catch (e) {
      // Skip malformed result — log to background console for visibility.
      console.warn('[parser] failed to parse result', e);
    }
  }
  return { sales, total_results };
}

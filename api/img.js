// Vercel serverless function: official card-art image proxy.
//
// Card images live at https://en.onepiece-cardgame.com/images/cardlist/card/
// <external_id>.png. A server-side fetch returns them fine, but the browser
// can't load them as a cross-origin <img> — Bandai's site sits behind
// Cloudflare/hotlink protection that rejects cross-origin browser image
// requests (works in curl, fails in-page). So we stream them back same-origin.
// Same rationale as api/tcgcsv.js (proxy an upstream the browser can't hit).
//
// Endpoint: /api/img?card=OP01-039  or  /api/img?card=OP01-039_p1
// `card` is the printing's external_id (card_code, optionally _pN/_rN).

const BASE = 'https://en.onepiece-cardgame.com/images/cardlist/card/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
// external_id charset: letters, digits, hyphen, underscore (e.g. OP01-039_p1, P-033).
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export default async function handler(req, res) {
  const card = String(req.query?.card || '');
  if (!ID_RE.test(card)) {
    res.status(400).json({ error: 'card query param must be a card external_id' });
    return;
  }
  try {
    const upstream = await fetch(`${BASE}${card}.png`, {
      headers: { 'User-Agent': UA, 'Referer': 'https://en.onepiece-cardgame.com/cardlist/' },
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `upstream ${upstream.status} for ${card}` });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    // Cache hard at the edge — card art is immutable per external_id.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
    res.status(200).end(buf);
  } catch (e) {
    res.status(502).json({ error: `img proxy failed: ${e.message || e}` });
  }
}

// Vercel serverless function: proxy for PSA's public API.
// PSA blocks direct browser calls with no CORS headers, so the client hits
// /api/psa?cert=NUMBER and this function makes the authenticated server-side
// call and relays the response.
//
// Env var: VITE_PSA_TOKEN (same value the client uses for the feature-gate
// check — Vercel exposes all env vars to serverless functions regardless of
// the VITE_ prefix, so no extra setup is required).

export default async function handler(req, res) {
  const cert = (req.query?.cert || '').toString().trim();
  if (!cert) {
    res.status(400).json({ error: 'cert query param is required' });
    return;
  }

  const token = process.env.VITE_PSA_TOKEN || process.env.PSA_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'PSA token not configured on the server' });
    return;
  }

  const upstream = `https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`;

  try {
    const r = await fetch(upstream, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(text || 'null');
  } catch (e) {
    res.status(502).json({ error: `PSA upstream fetch failed: ${e.message || e}` });
  }
}

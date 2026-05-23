// ============================================================================
// PSA Public API client — cert lookup by cert number.
//
// Auth: 40-char Bearer token. Sign up at https://www.psacard.com/publicapi
// then set VITE_PSA_TOKEN in .env.local.
//
// One known wrinkle: PSA's public API may not allow direct browser (CORS)
// requests. If you hit "Failed to fetch" in production, route through a
// tiny serverless proxy (Vercel function, Cloudflare Worker, etc.) and
// rewrite API_BASE to point at it.
// ============================================================================

const API_BASE = 'https://api.psacard.com/publicapi/cert';
const TOKEN = import.meta.env.VITE_PSA_TOKEN;

export const hasPsaToken = () => Boolean(TOKEN);

// Parse PSA grade strings ("GEM MT 10", "MINT 9", "EX-MT 6", "Authentic"…)
// into a numeric grade we can store on the entry. Returns null if no numeric
// grade could be extracted (e.g. PSA "Authentic" or unparseable).
const parseGrade = (s) => {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
};

// Fetch a PSA cert by its cert number. Returns a normalized object on
// success or null if the cert isn't found. Throws on auth/network errors.
export const fetchCert = async (certNumber) => {
  if (!TOKEN) throw new Error('PSA token missing — set VITE_PSA_TOKEN in .env.local');
  const url = `${API_BASE}/GetByCertNumber/${encodeURIComponent(String(certNumber).trim())}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`PSA API returned ${res.status}`);
  const json = await res.json();
  const cert = json?.PSACert;
  if (!cert) return null;

  return {
    cert_number: String(cert.CertNumber || certNumber),
    grading_company: 'PSA',
    grade: parseGrade(cert.GradeDescription || cert.CardGrade),
    grade_description: cert.GradeDescription || cert.CardGrade || '',
    subject: cert.Subject || '',
    category: cert.Category || '',
    year: cert.Year || '',
    brand: cert.Brand || '',
    // PSA stores the card number in either field depending on category.
    card_number: cert.CardNumber || cert.VarietyPedigree || '',
    spec_id: cert.SpecID || null,
    raw: cert,
  };
};

// Heuristic match: find the OPTCG catalog card that corresponds to the PSA
// cert. PSA's `CardNumber` is usually the bare card_set_id like "OP01-016".
// Returns the catalog card object or null. `catalog` is the array; we don't
// require a Map so callers don't have to build one just for this call.
export const matchCatalogCard = (cert, catalog) => {
  if (!cert || !cert.card_number || !Array.isArray(catalog)) return null;
  const needle = cert.card_number.trim().toUpperCase();
  const candidates = catalog.filter(c => (c.displayId || c.id || '').toUpperCase() === needle);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // Multiple printings share displayId (base + parallel/alt-art). Prefer the
  // one whose name most-closely matches the PSA subject.
  const subject = (cert.subject || '').toLowerCase();
  const scored = candidates.map(c => ({
    card: c,
    score: subject && (c.name || '').toLowerCase().includes(subject.split(' ')[0]) ? 1 : 0,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].card;
};

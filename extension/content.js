// Content script — runs in the context of any 130point.com page.
// Receives FETCH_AND_PARSE messages from the background service worker,
// performs the fetch in same-origin context (so Cloudflare sees the request
// as a normal in-tab navigation, not a cross-site extension request), and
// returns parsed sales as a JSON-serializable array.

(() => {
  function looksLikeCloudflareChallenge(html) {
    if (!html) return false;
    return /cf-browser-verification|Just a moment\.\.\.|cf_chl|Cloudflare/i.test(html);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type !== 'FETCH_AND_PARSE') return;
    (async () => {
      try {
        const r = await fetch(msg.path, {
          credentials: 'include',
          headers: { 'accept': '*/*' },
        });
        const text = await r.text();
        if (!r.ok) {
          sendResponse({
            ok: false,
            status: r.status,
            cloudflare: looksLikeCloudflareChallenge(text),
            sales: [],
            total_results: 0,
            sample: text.slice(0, 200),
          });
          return;
        }
        if (looksLikeCloudflareChallenge(text)) {
          sendResponse({
            ok: false,
            status: r.status,
            cloudflare: true,
            sales: [],
            total_results: 0,
            sample: text.slice(0, 200),
          });
          return;
        }
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const parser = self.OPTCG_LEDGER?.parseSearchResultsHtml;
        if (!parser) {
          sendResponse({ ok: false, status: r.status, sales: [], total_results: 0, error: 'parser not loaded' });
          return;
        }
        const { sales, total_results } = parser(doc);
        sendResponse({ ok: true, status: r.status, sales, total_results });
      } catch (e) {
        sendResponse({ ok: false, status: 0, sales: [], total_results: 0, error: String(e?.message || e) });
      }
    })();
    return true; // keep the channel open for the async sendResponse
  });
})();

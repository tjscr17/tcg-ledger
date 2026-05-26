import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Pull env into the dev middleware (Vite doesn't expose import.meta.env there).
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      react(),
      // Local-dev mirror of the Vercel /api/psa serverless function so PSA
      // lookups work the same in `npm run dev` as in production.
      {
        name: 'psa-dev-proxy',
        configureServer(server) {
          server.middlewares.use('/api/psa', async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const cert = (url.searchParams.get('cert') || '').trim();
            res.setHeader('Content-Type', 'application/json');
            if (!cert) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'cert query param is required' }));
              return;
            }
            const token = env.VITE_PSA_TOKEN || env.PSA_TOKEN;
            if (!token) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'PSA token not configured' }));
              return;
            }
            try {
              const upstream = `https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`;
              const r = await fetch(upstream, { headers: { Authorization: `Bearer ${token}` } });
              const text = await r.text();
              res.statusCode = r.status;
              res.end(text || 'null');
            } catch (e) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: `PSA upstream fetch failed: ${e.message || e}` }));
            }
          });
        },
      },
    ],
    build: { outDir: 'dist' },
  };
});

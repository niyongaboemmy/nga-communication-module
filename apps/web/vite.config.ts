import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Backend origins the dev server proxies to. Default to the services running on
// this machine; docker-compose overrides them with the backend container's
// hostname, since "localhost" inside the web container is the container itself.
const api      = process.env.TUPO_API_URL      ?? 'http://localhost:5190';
const realtime = process.env.TUPO_REALTIME_URL ?? 'http://localhost:5191';
const files    = process.env.TUPO_FILES_URL    ?? 'http://localhost:5192';
const worker   = process.env.TUPO_WORKER_URL   ?? 'http://localhost:5193';

/**
 * The browser only ever talks to this one origin. Everything backend is
 * proxied, which keeps cookies/CORS simple in development and mirrors the
 * nginx layout in production (see infra/nginx/tupo.conf).
 *
 * Order matters: Vite matches these in declaration order, so the more specific
 * `/api/files` prefix must come before the catch-all `/api`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5194,
    strictPort: true,
    host: true, // bind 0.0.0.0 so the port is reachable from outside a container
    proxy: {
      // Per-service health probes for the /app/system page. Each rewrites to
      // that service's own /health, since they all expose it at the root.
      '/svc/files/health':    { target: files,    changeOrigin: true, rewrite: () => '/health' },
      '/svc/realtime/health': { target: realtime, changeOrigin: true, rewrite: () => '/health' },
      '/svc/worker/health':   { target: worker,   changeOrigin: true, rewrite: () => '/health' },
      '/svc/api/health':      { target: api,      changeOrigin: true, rewrite: () => '/health' },

      '/api/files': { target: files,    changeOrigin: true },
      '/api':       { target: api,      changeOrigin: true },
      '/socket.io': { target: realtime, changeOrigin: true, ws: true },
    },
  },
});

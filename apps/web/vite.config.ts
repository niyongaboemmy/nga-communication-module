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
/**
 * The release id stamped into the bundle, so a browser error says which build
 * it came from (R-05). The deploy sets TUPO_RELEASE; otherwise the build time.
 */
const release = process.env.TUPO_RELEASE ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __TUPO_RELEASE__: JSON.stringify(release) },
  build: {
    rolldownOptions: {
      output: {
        /*
         * Vendor groups (P-01). Libraries change far less often than Tupo, so
         * each group keeps its hash (and the browser's cached copy) across
         * deploys. Icons are grouped because, left alone, every icon becomes
         * its own tiny file: about 60 requests on a phone for one screen.
         * The rich-text editor is big and used only by Mail and the feed
         * composer, so it stays out of the first download.
         */
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/, priority: 20 },
            { name: 'socket', test: /node_modules[\\/](socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser|@socket\.io)[\\/]/, priority: 20 },
            { name: 'editor', test: /node_modules[\\/](@tiptap|prosemirror-[a-z-]+|linkifyjs)[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
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

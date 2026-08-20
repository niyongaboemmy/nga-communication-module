import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
    proxy: {
      // Per-service health probes for the /app/system page. Each rewrites to
      // that service's own /health, since they all expose it at the root.
      '/svc/files/health':    { target: 'http://localhost:5192', changeOrigin: true, rewrite: () => '/health' },
      '/svc/realtime/health': { target: 'http://localhost:5191', changeOrigin: true, rewrite: () => '/health' },
      '/svc/worker/health':   { target: 'http://localhost:5193', changeOrigin: true, rewrite: () => '/health' },
      '/svc/api/health':      { target: 'http://localhost:5190', changeOrigin: true, rewrite: () => '/health' },

      '/api/files': { target: 'http://localhost:5192', changeOrigin: true },
      '/api':       { target: 'http://localhost:5190', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:5191', changeOrigin: true, ws: true },
    },
  },
});

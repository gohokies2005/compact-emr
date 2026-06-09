import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command, mode }) => {
  // Fail-closed deploy guard (frontend analog of the backend's assertProductionSafety). The
  // built bundle is static — it bakes in whatever env is present at build time and has NO runtime
  // check. If a `vite build` runs on a machine where .env.local set the demo/test bypasses
  // (VITE_DEMO_MODE=true or a dev bypass token), abort the build LOUDLY rather than ship a
  // Cognito-bypassing bundle to CloudFront. Only fires on `build` — dev (`vite`) and vitest are
  // unaffected.
  if (command === 'build') {
    const env = loadEnv(mode, process.cwd(), '');
    if (env.VITE_DEMO_MODE === 'true' || (env.VITE_DEV_BYPASS_TOKEN ?? '').length > 0) {
      throw new Error(
        'FATAL: refusing to build with demo/test bypasses enabled. VITE_DEMO_MODE=true or ' +
        'VITE_DEV_BYPASS_TOKEN is set (likely from .env.local). Unset them (or remove .env.local) ' +
        'before building for deploy.',
      );
    }
  }
  return {
    plugins: [
      react(),
      // Installable standalone PWA (chromeless, display:standalone). PHI-safe by design: the SW
      // precaches ONLY the static app shell (JS/CSS/HTML/SVG/fonts) and caches NOTHING at runtime —
      // the API and S3 are cross-origin and never touched by the SW, so no PHI is ever persisted to
      // the cache. navigateFallback is denylisted for /api/ and /d/ so deep links don't get the SPA
      // shell. Disabled in dev + vitest via devOptions.enabled:false.
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Aegis',
          short_name: 'Aegis',
          description: 'Aegis — for those who served',
          id: '/',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          theme_color: '#315F83',
          background_color: '#F8F7F3',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,woff2}'],
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/d\//],
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],
    // Dev-only: proxy /api to the local backend so the browser makes same-origin requests
    // (the Express app has no CORS middleware — CORS is handled at API Gateway in the cloud).
    server: {
      proxy: {
        '/api': { target: 'http://localhost:3000', changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/__tests__/setup.ts',
    },
  };
});

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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
    plugins: [react()],
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

import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// BUILD-PLAN H.1 and H.7.
// - `VITE_DATA_SOURCE=api` builds the production bundle (sign-in pages, API data source). It is served from the
//   site root with client-side routes such as /login/mfa, so its asset URLs are absolute (`base: '/'`). The sample
//   build keeps relative asset URLs (`base: './'`) as before.
// - `/api` is proxied to the api in `vite` (dev) and `vite preview`; `VITE_API_TARGET` names it (default
//   http://localhost:3000). The browser keeps talking to one origin, so the session cookie and the Origin check of
//   the api (F.2) work as behind NGINX; the api's `http.public_url` must be the address of this server.
// - `@mscd/shared` resolves to the TypeScript sources of the contract package, so no build of it is needed.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const api = env.VITE_DATA_SOURCE === 'api';
  const proxy = {
    '/api': { target: env.VITE_API_TARGET || 'http://localhost:3000', changeOrigin: false },
  };
  return {
    plugins: [react()],
    base: api ? '/' : './',
    resolve: {
      alias: [{ find: /^@mscd\/shared$/, replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) }],
    },
    server: { proxy },
    preview: { proxy },
  };
});

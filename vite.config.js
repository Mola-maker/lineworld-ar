import { defineConfig } from 'vite';

// `base: './'` so dist/ can be dropped on any static host or CDN sub-path.
// Camera + WebXR need HTTPS on phones: use `npm run dev` with a tunnel
// (e.g. cloudflared) or deploy dist/ to an HTTPS host.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});

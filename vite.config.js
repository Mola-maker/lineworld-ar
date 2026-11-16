import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `base: './'` so dist/ can be dropped on any static host or CDN sub-path.
// Camera + WebXR need HTTPS on phones: use `npm run dev` with a tunnel
// (e.g. cloudflared) or deploy dist/ to an HTTPS host.
// `npm run dev:https` serves over HTTPS with a self-signed certificate, so a
// phone on the same Wi-Fi can open https://<computer-ip>:5173 and use the camera
// (accept the certificate warning once).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  build: { target: 'es2022' },
}));

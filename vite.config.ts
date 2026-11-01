import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Preview builds must not expose inherited VITE_* variables. Production is unchanged.
  envPrefix: (process.env.VERCEL_ENV === 'preview' || (process.env.VERCEL && process.env.VERCEL_ENV !== 'production')) ? 'BOB_SAFE_PUBLIC_' : 'VITE_',
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { target: 'es2022', sourcemap: false },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative base so the static build works on any host or sub-path.
  base: './',
  // Reads the repo-root .env. Only these prefixes reach the bundle, and all are
  // public: VITE_* (VITE_API_URL, VITE_BASE_RPC_URL...) and vault/token addresses.
  // Never widen this: the same file holds private keys.
  envDir: repoRoot,
  envPrefix: ['VITE_', 'CAPLINE_VAULT_', 'WHITECHAIN_USDT'],
  plugins: [react()],
  server: {
    host: true,
    proxy: { '/api': `http://localhost:${process.env.APPROVE_PORT ?? 8787}` },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 800 },
});

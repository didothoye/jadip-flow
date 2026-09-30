import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000', '/mcp': 'http://localhost:3000', '/healthz': 'http://localhost:3000' } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 800 },
});

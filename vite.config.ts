import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  // Vitest config lives in vitest.config.ts (root) and each package/app.
  // Do NOT add a `test` section here — it would be picked up instead of the
  // dedicated vitest.config.ts and set the wrong environment for backend tests.
});

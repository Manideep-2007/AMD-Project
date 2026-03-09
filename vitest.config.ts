import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Root vitest configuration — covers all tests under src/test/.
 *
 * Environment strategy:
 *  - Default: "node" (platform-validation, example tests use fs/path and must run in Node)
 *  - api-client.test.ts: "happy-dom" (exercises localStorage, fetch)
 *
 * Package-level tests each have their own vitest.config.ts so turbo can
 * run them in parallel. This config ONLY handles the frontend application
 * tests that live in src/test/.
 */

const alias = { '@': path.resolve(__dirname, './src') };

export default defineConfig({
  test: {
    globals: true,
    projects: [
      // Node environment — platform-validation, example tests
      {
        resolve: { alias },
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: ['src/test/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['src/test/api-client.test.ts', '**/node_modules/**'],
        },
      },
      // Browser-like environment — api-client uses localStorage / fetch
      {
        resolve: { alias },
        test: {
          name: 'browser',
          globals: true,
          environment: 'happy-dom',
          include: ['src/test/api-client.test.ts'],
        },
      },
    ],
  },
});


import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // tsconfig leaves JSX to Next's compiler; the test transform needs its own instruction so a
  // surface component can be rendered directly (tests/surfaces).
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The embedded Postgres instances are memory-hungry; keep file parallelism modest.
    poolOptions: { threads: { maxThreads: 4 } },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

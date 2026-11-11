import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Test-only JWT secret (see vitest.setup.ts). Production code has no
    // fallback; without this, modules that load app config at import time
    // would throw in tests.
    setupFiles: ['./vitest.setup.ts'],
  },
});

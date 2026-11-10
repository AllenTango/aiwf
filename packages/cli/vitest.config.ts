import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Alias the workspace dep to core sources so tests run without a core build.
const coreAlias = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@aiwf/core': coreAlias }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
});

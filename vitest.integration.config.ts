import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

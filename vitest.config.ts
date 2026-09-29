import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    /*
     * Every suite talks to the same Postgres. Run the files one at a time:
     * parallel files were the only thing they shared, and a failure that
     * appeared roughly once in thirty runs - in a different file each time -
     * had no other explanation. Slower, and worth it for a suite you can trust.
     */
    fileParallelism: false,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});

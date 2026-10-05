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
    /*
     * These are not unit tests. Each one drives real work through a real
     * Postgres - a week of absences, a whole register imported, a call answered
     * turn by turn - and the slowest sits a little either side of vitest's
     * five-second default. That produced a suite which failed roughly one run in
     * four, always on time and never on an assertion, which is the kind of
     * failure people learn to ignore. The work is the point; the clock is not.
     */
    testTimeout: 20_000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});

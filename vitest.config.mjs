import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Kill node-config 0.4's runtime.json persistence in workers too (the
    // setup file loads config before app.js can set these). See app.js.
    env: {
      NODE_CONFIG_PERSIST_ON_CHANGE: 'N',
      NODE_CONFIG_DISABLE_FILE_WATCH: 'Y',
    },
    // Only the new tests for now; legacy mocha files (test/lib/**) are ported in Slice 2.
    include: ['test/**/*.test.js'],
    globalSetup: ['./test/helpers/mongo-global.mjs'],
    setupFiles: ['./test/helpers/vitest-setup.cjs'],
    testTimeout: 30000,   // first run downloads the mongod binary; boot takes a moment
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html'],
    },
  },
});

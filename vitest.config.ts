import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `npm run test:integration` compiles the tests into out-test/; those copies
    // run inside VS Code, not under vitest.
    exclude: [...configDefaults.exclude, 'out-test/**', '.vscode-test/**'],
  },
});

// Use the upstream tests without Vite's dev-server hooks that spawn yarn + Bash.
// Locales are already compiled by the production build step.
import { resolve } from 'node:path';
export default {
  root: resolve(import.meta.dirname, '../.build/frontend'),
  resolve: { tsconfigPaths: true },
  test: { environment: 'happy-dom', setupFiles: ['./vitest-setup.js'] }
};

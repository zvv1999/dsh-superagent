import { isBuiltin } from 'node:module'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  // jsdom runs in Node; preserve builtin IDs before Vite 8 replaces them with a browser placeholder.
  plugins: [{ name: 'vitest-node-builtins', enforce: 'pre', resolveId(id) { if (isBuiltin(id)) return { id, external: true } } }],
  // Share one React instance across DSH client packages and tests.
  resolve: { dedupe: ['react', 'react-dom'] },
  // The host may run in production mode, where React disables act(); test workers need the test runtime.
  test: { include: ['tests/**/*.spec.{ts,tsx}'], env: { NODE_ENV: 'test' },
    // Transform the published host primitives and their CSS modules, so panel tests exercise the real controls.
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } } },
})

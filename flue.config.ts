import { defineConfig } from '@flue/cli/config';

// Last Light on Flue — Node service target. Source is discovered from `src/`
// (agents/, workflows/, channels/, app.ts). See spec/IMPLEMENTATION-PLAN.md.
//
// NOTE: `defineConfig` is exported from `@flue/cli/config`, NOT `@flue/runtime`
// (verified — see spec/flue-reference.md §0).
export default defineConfig({
  target: 'node',
});

// A named `vite` export is merged into the dev/build Vite config by the flue CLI
// (`resolveConfig` reads `configModule.vite`). The Node dev reloader rebuilds on
// EVERY non-`dist` change under the project root (its `shouldRebuildOn` is
// unconditionally true), so the runtime SQLite DBs under `.data/` — whose
// `-wal`/`-shm` files churn on every write — would otherwise reload-loop the dev
// server. Ignoring `.data` in the watcher stops the loop (these are runtime
// state, never source). `dist`/`node_modules`/`.git` are already vite defaults.
export const vite = {
  server: {
    watch: {
      ignored: ['**/.data/**'],
    },
  },
};

import { defineConfig } from '@flue/cli/config';

// Last Light on Flue — Node service target. Source is discovered from `src/`
// (agents/, workflows/, channels/, app.ts). See spec/IMPLEMENTATION-PLAN.md.
//
// NOTE: `defineConfig` is exported from `@flue/cli/config`, NOT `@flue/runtime`,
// in the installed @flue/runtime 1.0.0-beta.2 (verified — see spec/flue-reference.md §0).
export default defineConfig({
  target: 'node',
});

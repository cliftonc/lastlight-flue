import { defineConfig, type Plugin } from 'vitest/config';

// Vitest is the acceptance-test runner for every phase (see BUILD-LOOP.md).
// Flue ships `@flue/runtime/test-utils` (store-contract suite) and
// `examples/vitest-evals` for eval-style tests — wired in per phase as needed.

// Skill imports (`import x from '../skills/<name>/SKILL.md' with { type: 'skill' }`)
// are a Flue-build/tsx feature; vite's import-analysis cannot parse a raw .md as JS.
// This plugin maps any `*/SKILL.md` import to a tiny stub `SkillReference` so tests
// that transitively import a skill-using agent run offline. The REAL skill loading
// is exercised by the Flue build, not by these unit tests.
function stubSkillMd(): Plugin {
  const STUB_ID = '\0flue-skill-md-stub';
  return {
    name: 'stub-skill-md',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('/SKILL.md') || source.endsWith('.md')) return STUB_ID;
      return null;
    },
    load(id) {
      if (id === STUB_ID) {
        // A minimal stand-in; agents only pass these references through to Flue.
        return `export default { name: 'stub-skill', __stub: true };`;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [stubSkillMd()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'examples/**/*.test.ts'],
    // Keep `pnpm test` green during early bootstrap before any phase tests exist.
    passWithNoTests: true,
  },
});

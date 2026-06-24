import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

// Vitest is the acceptance-test runner for every phase (see BUILD-LOOP.md).
// Flue ships `@flue/runtime/test-utils` (store-contract suite) and
// `examples/vitest-evals` for eval-style tests — wired in per phase as needed.

// Markdown imports (`import x from '../foo.md' with { type: '...' }`) are a
// Flue-build/tsx feature; vite's import-analysis cannot parse a raw `.md` as JS.
// This plugin maps `.md` imports to JS modules so tests that transitively import
// a markdown-using module run offline. It has TWO branches, mirroring the two
// Flue markdown import attributes:
//
//   - `*/SKILL.md` (`with { type: 'skill' }`) → a tiny stub `SkillReference`
//     `{ name, __stub }`. The REAL skill loading is exercised by the Flue build,
//     not by these unit tests; agents only pass these references through to Flue.
//   - any other `*.md` (`with { type: 'markdown' }`, e.g. agent-context) → the
//     REAL file contents inlined as a default-exported string, matching what
//     Flue inlines at build time, so persona tests can assert real content.
function stubMarkdown(): Plugin {
  // Marker prefix so a SKILL.md resolves to a UNIQUE-per-skill stub (the parent
  // directory name) — beta.3 `defineAgentProfile` rejects duplicate skill names.
  const SKILL_STUB_PREFIX = '\0flue-skill-md-stub:';
  // Marker suffix so resolved markdown ids round-trip the real file path into
  // the `load` hook (vite namespaces it via the leading NUL).
  const MD_PREFIX = '\0flue-markdown:';
  return {
    name: 'stub-markdown',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.endsWith('/SKILL.md')) {
        // Derive a stable skill name from the parent dir
        // (…/skills/building/SKILL.md → "building"), so distinct skills get
        // distinct stub names within a single agent profile.
        const m = source.match(/([^/]+)\/SKILL\.md$/);
        return SKILL_STUB_PREFIX + (m ? m[1] : 'stub-skill');
      }
      if (source.endsWith('.md')) {
        // Resolve relative to the importer so we can read the real file in load().
        const abs = new URL(source, new URL(`file://${importer}`)).pathname;
        return MD_PREFIX + abs;
      }
      return null;
    },
    load(id) {
      if (id.startsWith(SKILL_STUB_PREFIX)) {
        // beta.3 `defineAgentProfile` validates skills EAGERLY at definition time and
        // requires a non-empty `description` + UNIQUE names (beta.2's lazy
        // `createAgent` initializer never tripped this). The stub carries both.
        const name = id.slice(SKILL_STUB_PREFIX.length);
        return `export default { name: ${JSON.stringify(name)}, description: 'stub skill (vitest)', __stub: true };`;
      }
      if (id.startsWith(MD_PREFIX)) {
        const path = id.slice(MD_PREFIX.length);
        const contents = readFileSync(path, 'utf-8');
        return `export default ${JSON.stringify(contents)};`;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [stubMarkdown()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'examples/**/*.test.ts'],
    // Keep `pnpm test` green during early bootstrap before any phase tests exist.
    passWithNoTests: true,
  },
});

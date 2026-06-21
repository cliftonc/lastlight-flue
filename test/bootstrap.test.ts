import { describe, it, expect } from 'vitest';

// Bootstrap smoke test: pins the *installed* @flue/runtime 1.0.0-beta.2 API
// surface so the drift recorded in spec/flue-reference.md §0 is an executable
// regression guard. The design docs were researched against `withastro/flue@main`
// (ahead of the pinned package) and assumed `defineAgent` / `defineWorkflow` /
// top-level `invoke`; the installed beta.2 uses `createAgent`, a file-based
// `run()` workflow form, and `defineConfig` from `@flue/cli/config`. If a future
// `pnpm update` flips these, this test fails loudly instead of silently.

describe('installed @flue/runtime beta.2 API surface', () => {
  it('exports createAgent (not defineAgent) from the main entry', async () => {
    const runtime = await import('@flue/runtime');
    expect(runtime).toHaveProperty('createAgent');
    expect(runtime).toHaveProperty('dispatch');
    expect(runtime).toHaveProperty('defineTool');
    expect(runtime).toHaveProperty('defineAgentProfile');
    // Drift markers: these were assumed present by the design docs but are NOT
    // in the installed beta.2 main export.
    expect(runtime).not.toHaveProperty('defineAgent');
    expect(runtime).not.toHaveProperty('defineWorkflow');
    expect(runtime).not.toHaveProperty('invoke');
  });

  it('exports defineConfig from @flue/cli/config', async () => {
    const config = await import('@flue/cli/config');
    expect(typeof config.defineConfig).toBe('function');
  });

  it('exports local() and sqlite() from @flue/runtime/node', async () => {
    const node = await import('@flue/runtime/node');
    expect(typeof node.local).toBe('function');
    expect(typeof node.sqlite).toBe('function');
  });

  it('exports flue() routing from @flue/runtime/routing', async () => {
    const routing = await import('@flue/runtime/routing');
    expect(typeof routing.flue).toBe('function');
  });
});

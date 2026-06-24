import { describe, it, expect } from 'vitest';

// Bootstrap smoke test: pins the *installed* @flue/runtime 1.0.0-beta.3 API
// surface as an executable regression guard. beta.3 landed the primitives the
// design docs always assumed — `defineAgent`, `defineAgentProfile`,
// `defineWorkflow`, and a top-level `invoke` — alongside the still-present
// `createAgent` (now a deprecated alias) / `dispatch` / `defineTool`. If a future
// `pnpm update` regresses these, this test fails loudly instead of silently.

describe('installed @flue/runtime beta.3 API surface', () => {
  it('exports the beta.3 define* primitives + invoke from the main entry', async () => {
    const runtime = await import('@flue/runtime');
    // Still present (createAgent is now a deprecated alias for defineAgent).
    expect(runtime).toHaveProperty('createAgent');
    expect(runtime).toHaveProperty('dispatch');
    expect(runtime).toHaveProperty('defineTool');
    // beta.3 primitives the migration relies on.
    expect(runtime).toHaveProperty('defineAgent');
    expect(runtime).toHaveProperty('defineAgentProfile');
    expect(runtime).toHaveProperty('defineWorkflow');
    expect(runtime).toHaveProperty('invoke');
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

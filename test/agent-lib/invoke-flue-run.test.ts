import { describe, it, expect, vi, beforeEach } from 'vitest';

// Offline unit test for the in-process invoker. Both seams are mocked: `@flue/runtime`'s
// `invoke` (so the real runtime is never touched) and the workflow-registry (so the
// all-workflows graph is never loaded). We assert the wiring: resolve-by-name → invoke
// with `{ input }` → return the receipt; and that an unknown name short-circuits invoke.

const { invokeMock, resolveWorkflowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  resolveWorkflowMock: vi.fn(),
}));
vi.mock('@flue/runtime', () => ({ invoke: invokeMock }));
vi.mock('../../src/agent-lib/workflow-registry.ts', () => ({
  resolveWorkflow: resolveWorkflowMock,
}));

import { invokeFlueRun } from '../../src/agent-lib/invoke-flue-run.ts';

describe('invokeFlueRun', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resolveWorkflowMock.mockReset();
  });

  it('resolves the workflow by name and invokes it with { input }, returning the receipt', async () => {
    const fakeDef = { __wf: 'build' };
    resolveWorkflowMock.mockReturnValue(fakeDef);
    invokeMock.mockResolvedValue({ runId: 'run-123' });

    const input = { runId: 'run-123', owner: 'acme', repo: 'alpha' };
    const receipt = await invokeFlueRun('build', input);

    expect(resolveWorkflowMock).toHaveBeenCalledWith('build');
    expect(invokeMock).toHaveBeenCalledWith(fakeDef, { input });
    expect(receipt).toEqual({ runId: 'run-123' });
  });

  it('propagates an unknown-workflow error from the registry and never calls invoke', async () => {
    resolveWorkflowMock.mockImplementation((name: string) => {
      throw new Error(`invokeFlueRun: unknown workflow "${name}" (known: build)`);
    });

    await expect(invokeFlueRun('nope', {})).rejects.toThrow(/unknown workflow "nope"/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

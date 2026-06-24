import { describe, it, expect } from 'vitest';

import { WORKFLOW_REGISTRY, resolveWorkflow } from '../../src/agent-lib/workflow-registry.ts';
import { CRON_DEFS } from '../../src/crons.ts';

// Imports the REAL registry (and thus every workflow definition) to prove that every
// name the invoker seams pass — the cron fan-out targets + the two resume-path workflows
// — resolves to a definition, and that an unknown name fails loudly.

describe('workflow-registry', () => {
  it('registers a definition for every cron-targeted workflow', () => {
    for (const def of CRON_DEFS) {
      expect(() => resolveWorkflow(def.workflow), `cron workflow "${def.workflow}"`).not.toThrow();
    }
  });

  it('registers the resume-path workflows', () => {
    expect(resolveWorkflow('build')).toBeDefined();
    expect(resolveWorkflow('explore')).toBeDefined();
  });

  it('throws a clear, named error on an unknown workflow', () => {
    expect(() => resolveWorkflow('does-not-exist')).toThrow(
      /unknown workflow "does-not-exist"/,
    );
  });

  it('keys every entry by a non-empty name with a defined definition', () => {
    const entries = Object.entries(WORKFLOW_REGISTRY);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, def] of entries) {
      expect(name).toBeTruthy();
      expect(def).toBeDefined();
    }
  });
});

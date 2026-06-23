import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LastLightConfig, RouteConfig } from '../config.ts';
import {
  buildWorkflowsList,
  createDefaultWorkflowsReader,
  createSqliteOverrideStore,
  discoverWorkflowNames,
  routeTriggers,
  toWorkflowDefinition,
  toWorkflowFullDefinition,
  toWorkflowSummary,
  triggerKindsOf,
  workflowTriggers,
  type WorkflowOverrideStore,
  type WorkflowRecord,
  type WorkflowsReader,
} from './workflows-reader.ts';

// Workflows browser · reader unit tests. Two halves, both OFFLINE (no Flue
// runtime, no HTTP):
//   1. Pure adapters (WorkflowRecord → dashboard shapes) + trigger derivation —
//      sample records in, frontend-contract shapes out. Pins the EXACT
//      dashboard/src/api.ts contract (WorkflowSummary/Definition/Full/Trigger).
//   2. The default reader over a TEMP `src/`-shaped fixture (workflows/ + prompts/
//      + skills/) with an in-memory override store — exercises real discovery /
//      kill-switch / file reads without the live tree.

// ── A minimal config double (only the fields the reader reads). ───────────────
const routes: RouteConfig = {
  github: {
    issue_opened: 'issue-triage',
    pr_opened: 'pr-review',
    pr_synchronize: 'pr-review',
    issue_comment: 'issue-comment',
    issue_build: 'github-orchestrator',
    security_feedback: 'security-feedback',
  },
  slack: {
    review: 'pr-review',
    build: 'github-orchestrator',
  },
};

function fakeConfig(overrides: Partial<LastLightConfig> = {}): LastLightConfig {
  return {
    routes,
    disabled: {
      workflows: [],
      crons: [],
      prompts: [],
      skills: [],
      agentContext: [],
    },
    stateDir: '/tmp/unused',
    ...overrides,
  } as unknown as LastLightConfig;
}

// ── A fake reader for the pure-adapter + list-builder tests. ──────────────────
function fakeReader(records: WorkflowRecord[]): WorkflowsReader {
  const enabled = new Map<string, boolean>();
  return {
    list: () => records,
    get: (name) => records.find((r) => r.name === name) ?? null,
    triggers: (name) => workflowTriggers(name, routes),
    isEnabled: (name) => enabled.get(name) ?? true,
    setEnabled: (name, e) => {
      enabled.set(name, e);
      return e;
    },
    rawSource: (name) => `// source for ${name}`,
    loadPrompt: (p) => `prompt:${p}`,
    loadSkill: (name) => `skill:${name}`,
  };
}

describe('triggerKindsOf / workflowTriggers (config + cron derived)', () => {
  it('orders distinct trigger kinds (cron, github, mention, slack, internal)', () => {
    const kinds = triggerKindsOf([
      { kind: 'slack', command: 'review', description: '' },
      { kind: 'github', event: 'pr.opened', description: '' },
      { kind: 'cron', name: 'check-prs-awaiting-review', schedule: '*/30 * * * *' },
    ]);
    expect(kinds).toEqual(['cron', 'github', 'slack']);
  });

  it('derives github + slack triggers for pr-review and includes its cron', () => {
    const t = workflowTriggers('pr-review', routes);
    // cron-review.yaml → check-prs-awaiting-review targets pr-review.
    expect(t).toContainEqual({
      kind: 'cron',
      name: 'check-prs-awaiting-review',
      schedule: '*/30 * * * *',
    });
    expect(t).toContainEqual({ kind: 'github', event: 'pr.opened', description: 'A PR is opened' });
    expect(t.some((x) => x.kind === 'slack')).toBe(true);
  });

  it('remaps the github-orchestrator route alias to the `build` workflow', () => {
    const map = routeTriggers(routes);
    expect(map.has('build')).toBe(true);
    expect(map.has('github-orchestrator')).toBe(false);
    const slack = (map.get('build') ?? []).find((t) => t.kind === 'slack');
    expect(slack).toBeTruthy();
  });
});

describe('pure adapters (WorkflowRecord → dashboard shapes)', () => {
  const withPhases: WorkflowRecord = {
    name: 'build',
    kind: 'build',
    description: 'Architect -> Executor -> Reviewer',
    trigger: 'build',
    phases: [
      { name: 'architect', type: 'agent', prompt: 'prompts/architect.md' },
      {
        name: 'reviewer',
        label: 'Review',
        type: 'agent',
        approval_gate: 'post_reviewer',
        loop: { max_cycles: 3 },
        depends_on: ['architect'],
      },
    ],
  };

  it('toWorkflowDefinition projects the compact phase subset', () => {
    const def = toWorkflowDefinition(withPhases);
    expect(def).toEqual({
      name: 'build',
      kind: 'build',
      description: 'Architect -> Executor -> Reviewer',
      phases: [
        { name: 'architect', label: 'architect', type: 'agent', hasLoop: false, approvalGate: undefined },
        { name: 'reviewer', label: 'Review', type: 'agent', hasLoop: true, approvalGate: 'post_reviewer' },
      ],
    });
  });

  it('toWorkflowFullDefinition preserves every phase field + top-level metadata', () => {
    const full = toWorkflowFullDefinition(withPhases);
    expect(full.name).toBe('build');
    expect(full.trigger).toBe('build');
    expect(full.phases[1]!.loop).toEqual({ max_cycles: 3 });
    expect(full.phases[1]!.depends_on).toEqual(['architect']);
  });

  it('toWorkflowSummary computes phaseCount/hasDag/triggerKinds/enabled', () => {
    const reader = fakeReader([withPhases]);
    const sum = toWorkflowSummary(reader, withPhases);
    expect(sum.phaseCount).toBe(2);
    expect(sum.hasDag).toBe(true); // reviewer depends_on architect
    expect(sum.enabled).toBe(true);
    // build's triggers come from issue_build (mention) + slack build (slack);
    // github-orchestrator route alias is remapped to `build`.
    expect(sum.triggerKinds).toEqual(['mention', 'slack']);
  });

  it('buildWorkflowsList sorts rows by name', () => {
    const reader = fakeReader([
      { name: 'zeta', kind: 'zeta', phases: [] },
      { name: 'alpha', kind: 'alpha', phases: [] },
    ]);
    const list = buildWorkflowsList(reader);
    expect(list.map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });

  it('honest defaults: a phase-less workflow → phaseCount 0, hasDag false', () => {
    const reader = fakeReader([{ name: 'answer', kind: 'answer', phases: [] }]);
    const sum = toWorkflowSummary(reader, { name: 'answer', kind: 'answer', phases: [] });
    expect(sum.phaseCount).toBe(0);
    expect(sum.hasDag).toBe(false);
  });
});

describe('discoverWorkflowNames (mirror of @flue/cli discoverModules)', () => {
  it('takes *.ts basenames, drops .test.ts / .d.ts / subdirs / non-source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-discover-'));
    try {
      writeFileSync(join(dir, 'pr-review.ts'), 'export async function run(){}');
      writeFileSync(join(dir, 'answer.ts'), 'export async function run(){}');
      writeFileSync(join(dir, 'answer.test.ts'), '// colocated test');
      writeFileSync(join(dir, 'types.d.ts'), 'export {}');
      writeFileSync(join(dir, 'README.md'), '# nope');
      mkdirSync(join(dir, '__tests__'));
      writeFileSync(join(dir, '__tests__', 'x.ts'), '// nested');
      const names = discoverWorkflowNames(dir).sort();
      expect(names).toEqual(['answer', 'pr-review']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing directory', () => {
    expect(discoverWorkflowNames('/no/such/dir')).toEqual([]);
  });
});

describe('createSqliteOverrideStore (in-memory)', () => {
  it('round-trips an override; absent name → undefined', () => {
    const store: WorkflowOverrideStore = createSqliteOverrideStore(':memory:');
    expect(store.get('pr-review')).toBeUndefined();
    store.set('pr-review', false);
    expect(store.get('pr-review')).toBe(false);
    store.set('pr-review', true);
    expect(store.get('pr-review')).toBe(true);
  });
});

describe('createDefaultWorkflowsReader (over a temp src/ fixture)', () => {
  function makeFixture() {
    const root = mkdtempSync(join(tmpdir(), 'wf-reader-'));
    mkdirSync(join(root, 'workflows'));
    mkdirSync(join(root, 'prompts'));
    mkdirSync(join(root, 'skills', 'pr-review'), { recursive: true });
    writeFileSync(join(root, 'workflows', 'pr-review.ts'), '// pr-review source\nexport async function run(){}');
    writeFileSync(join(root, 'workflows', 'answer.ts'), 'export async function run(){}');
    writeFileSync(join(root, 'workflows', 'answer.test.ts'), '// test, not a workflow');
    writeFileSync(join(root, 'prompts', 'reviewer.md'), 'review prompt');
    writeFileSync(join(root, 'skills', 'pr-review', 'SKILL.md'), '# pr-review skill');
    return root;
  }

  it('discovers workflows, derives triggers/enabled, reads source/prompt/skill', () => {
    const root = makeFixture();
    const overrides = new Map<string, boolean>();
    const store: WorkflowOverrideStore = {
      get: (n) => overrides.get(n),
      set: (n, e) => void overrides.set(n, e),
    };
    try {
      const reader = createDefaultWorkflowsReader({
        sourceRoot: root,
        config: fakeConfig(),
        overrideStore: store,
      });

      const names = reader.list().map((r) => r.name).sort();
      expect(names).toEqual(['answer', 'pr-review']);

      // honest defaults: kind = name, no description, no phases.
      const rec = reader.get('pr-review')!;
      expect(rec.kind).toBe('pr-review');
      expect(rec.description).toBeUndefined();
      expect(rec.phases).toEqual([]);
      expect(reader.get('nonexistent')).toBeNull();

      // triggers derived from config routes + crons.
      const kinds = triggerKindsOf(reader.triggers('pr-review'));
      expect(kinds).toContain('github');
      expect(kinds).toContain('cron');

      // kill switch: default enabled, toggle persists via the store.
      expect(reader.isEnabled('pr-review')).toBe(true);
      reader.setEnabled('pr-review', false);
      expect(reader.isEnabled('pr-review')).toBe(false);

      // yaml endpoint source = the .ts module text.
      expect(reader.rawSource('pr-review')).toContain('pr-review source');

      // prompt + skill file reads (accepts the reference `prompts/` prefix).
      expect(reader.loadPrompt('prompts/reviewer.md')).toBe('review prompt');
      expect(reader.loadSkill('pr-review')).toBe('# pr-review skill');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects config.disabled.workflows for the default enabled state', () => {
    const root = makeFixture();
    try {
      const reader = createDefaultWorkflowsReader({
        sourceRoot: root,
        config: fakeConfig({
          disabled: { workflows: ['answer'], crons: [], prompts: [], skills: [], agentContext: [] },
        }),
        overrideStore: createSqliteOverrideStore(':memory:'),
      });
      expect(reader.isEnabled('answer')).toBe(false);
      expect(reader.isEnabled('pr-review')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects path-escaping prompt paths and unknown skill names', () => {
    const root = makeFixture();
    try {
      const reader = createDefaultWorkflowsReader({
        sourceRoot: root,
        config: fakeConfig(),
        overrideStore: createSqliteOverrideStore(':memory:'),
      });
      expect(() => reader.loadPrompt('../secret.md')).toThrow();
      expect(() => reader.loadSkill('../etc')).toThrow();
      expect(() => reader.rawSource('bad name!')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

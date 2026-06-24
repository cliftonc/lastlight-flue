/**
 * `workflow-registry` — a name → `WorkflowDefinition` map for IN-PROCESS invocation.
 *
 * Beta.3's `invoke(workflow, { input })` takes the workflow DEFINITION object (the
 * `defineWorkflow(...)` default export), not the string name the injected invoker
 * seams (`CronInvoker` in `src/crons.ts`, `Reinvoker` in `src/resume*.ts`) carry. This
 * registry bridges that gap: it imports every workflow's default export and keys it by
 * its discovery name (= filename), so `invokeFlueRun(name, input)` can resolve the def.
 *
 * ESM module caching guarantees the def imported here is the SAME instance Flue
 * discovered at build, so the runtime keys the run correctly.
 *
 * WHY this is loaded LAZILY (via dynamic `import()` from `src/agent-lib/invoke-flue-run.ts`,
 * never statically from `crons.ts`/`resume*.ts`): importing it pulls in ALL workflow
 * modules (and their agents). Keeping it off the module-load path of the invoker callers
 * means the offline cron/resume tests — which import those modules but inject fake
 * invokers — never drag the whole workflow graph in. Lives in `src/agent-lib/` (NOT
 * discovered as a Flue entry).
 */
import type { WorkflowDefinition } from '@flue/runtime';

import answer from '../workflows/answer.ts';
import build from '../workflows/build.ts';
import explore from '../workflows/explore.ts';
import gated from '../workflows/gated.ts';
import issueComment from '../workflows/issue-comment.ts';
import issueTriage from '../workflows/issue-triage.ts';
import prComment from '../workflows/pr-comment.ts';
import prFix from '../workflows/pr-fix.ts';
import prReview from '../workflows/pr-review.ts';
import repoHealth from '../workflows/repo-health.ts';
import securityFeedback from '../workflows/security-feedback.ts';
import securityReview from '../workflows/security-review.ts';

/**
 * Every discovered workflow, keyed by its discovery name (= the `src/workflows/*.ts`
 * filename). The invoker seams pass these exact names.
 */
export const WORKFLOW_REGISTRY: Readonly<Record<string, WorkflowDefinition>> = {
  answer,
  build,
  explore,
  gated,
  'issue-comment': issueComment,
  'issue-triage': issueTriage,
  'pr-comment': prComment,
  'pr-fix': prFix,
  'pr-review': prReview,
  'repo-health': repoHealth,
  'security-feedback': securityFeedback,
  'security-review': securityReview,
};

/** Resolve a workflow name to its definition, throwing a clear error if unknown. */
export function resolveWorkflow(name: string): WorkflowDefinition {
  const def = WORKFLOW_REGISTRY[name];
  if (!def) {
    const known = Object.keys(WORKFLOW_REGISTRY).join(', ');
    throw new Error(`invokeFlueRun: unknown workflow "${name}" (known: ${known})`);
  }
  return def;
}

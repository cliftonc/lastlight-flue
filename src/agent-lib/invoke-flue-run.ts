/**
 * `invokeFlueRun` — the IN-PROCESS workflow re-entry (beta.3). The default for the cron
 * fan-out (`src/crons.ts`) and both resume paths (`src/resume.ts`, `src/resume-explore.ts`),
 * replacing the old `spawn('pnpm exec flue run …')` child process. Each caller still keeps
 * it behind an injected seam so tests never invoke the real runtime.
 *
 * WHY in-process now (it wasn't before): the codebase was written against @flue/runtime
 * beta.2, which had NO top-level `invoke` export — a fresh `flue run` process was the only
 * proven cross-process re-entry (see the old comments in `crons.ts`/`resume.ts`). Beta.3
 * exports `invoke(workflow, { input })`, so we call it directly. This also keeps the agent
 * transcript OFF stdout: the per-delta thinking/message/tool printing lives only in the
 * `@flue/cli` `flue run` presenter — the runtime's `invoke()` is silent. Events still
 * persist to `.data/flue.db` and surface in the admin console exactly as before.
 *
 * CONTRACT — fire-and-forget. `invoke()` resolves with `{ runId }` after ADMISSION, not
 * after the workflow completes; the run then proceeds inside the server's runtime. Callers
 * must NOT depend on the return reflecting a finished run — the app-owned run record is the
 * source of truth (resume.ts already assumes this).
 *
 * PRECONDITION — must run INSIDE the configured server. `invoke()` reads a module-level
 * runtime config set by the generated entry's `configureFlueRuntime()` at boot; called
 * before that it throws `WorkflowInvocationNotConfiguredError`. Crons start post-boot and
 * resumes are channel-triggered, so this holds.
 *
 * Lives in `src/agent-lib/` (NOT discovered).
 */
import { invoke, type WorkflowDefinition, type WorkflowInvocationReceipt } from '@flue/runtime';

/** The cast target: with a base-typed `WorkflowDefinition`, `invoke`'s per-workflow request
 * generic erases to a structural `{ input }`. The runtime re-validates `input` against the
 * workflow's own action schema, so this single boundary cast is safe. */
type InvokeFn = (
  workflow: WorkflowDefinition,
  request: { input: unknown },
) => Promise<WorkflowInvocationReceipt>;

/**
 * Invoke a workflow in-process by name. Resolves the definition from the (lazily loaded)
 * registry, then admits the run. Returns the receipt `{ runId }` — fire-and-forget.
 */
export async function invokeFlueRun(
  workflow: string,
  input: unknown,
): Promise<WorkflowInvocationReceipt> {
  // Dynamic import keeps the all-workflows graph off the module-load path of the seam
  // callers (crons/resume), so their offline tests never drag it in. See workflow-registry.
  const { resolveWorkflow } = await import('./workflow-registry.ts');
  const def = resolveWorkflow(workflow);
  // SERIALIZATION PARITY with the old cross-process path: `flue run --input <JSON>` round-
  // tripped the payload through `JSON.stringify`, which SILENTLY DROPS `undefined` fields
  // (e.g. an optional `reopened`/`branch` a router leaves unset). In-process `invoke()`
  // instead asserts STRICT JSON and THROWS on any `undefined`. Replicate the old strip with
  // a JSON round-trip so existing router payloads stay valid.
  const normalizedInput = JSON.parse(JSON.stringify(input ?? null));
  return (invoke as InvokeFn)(def, { input: normalizedInput });
}

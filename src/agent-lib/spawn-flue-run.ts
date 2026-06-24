/**
 * `spawnFlueRun` — the ONE cross-process workflow re-entry the durability model
 * relies on: a fresh `pnpm exec flue run <workflow> --input <json>` process. Shared
 * by the cron fan-out (`src/crons.ts`) and both resume paths (`src/resume.ts`,
 * `src/resume-explore.ts`); each keeps it behind an injected seam so tests never spawn.
 *
 * WHY `spawn`, NOT `execFile`/`exec` (the bug this fixes): a real build/explore run
 * streams MEGABYTES to stdout (the `flue run` banner + every agent thinking/message
 * delta + tool output). `promisify(execFile)` buffers all of that in memory and caps
 * it at Node's default `maxBuffer` of 1 MB — once exceeded, Node SIGTERMs the child
 * MID-RUN and rejects with the accumulated buffer. That manifested as: the workflow
 * dying ~minutes in with no error event (abrupt stream stop), the Flue run left
 * orphaned as `active` forever, and the agent's entire context "dumped" into the
 * parent error. `spawn` with inherited stdio streams straight to the parent fds with
 * NO buffer cap, so a long, chatty run completes normally.
 *
 * Lives in `src/agent-lib/` (NOT discovered).
 */
import { spawn } from "node:child_process";

export interface SpawnFlueRunOptions {
  /** Hard wall-clock cap; the child is SIGTERM'd past it. Default 30 min. */
  timeoutMs?: number;
}

/**
 * Default wall-clock cap. A real multi-phase build legitimately needs dependency
 * install + architect + executor (which runs the repo's build/test gate) + a reviewer
 * loop — the original 10 min cap fired mid-run on a normal build. 30 min covers a real
 * build while still terminating a genuinely wedged child.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Spawn `flue run <workflow> --input <json>` and resolve when it exits 0; reject on a
 * non-zero exit, a terminating signal, a spawn error, or the timeout. Child stdio is
 * INHERITED (no `maxBuffer`): the run's live output flows to the parent console and is
 * persisted to the Flue run store for the dashboard regardless.
 */
export function spawnFlueRun(
  workflow: string,
  input: unknown,
  opts: SpawnFlueRunOptions = {},
): Promise<void> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "flue", "run", workflow, "--input", JSON.stringify(input)],
      // inherit stdout/stderr — unbounded, unlike execFile's 1 MB maxBuffer.
      { stdio: ["ignore", "inherit", "inherit"] },
    );

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`flue run ${workflow} timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `flue run ${workflow} exited ${
              code !== null ? `with code ${code}` : `via signal ${signal}`
            }`,
          ),
        );
      }
    });
  });
}

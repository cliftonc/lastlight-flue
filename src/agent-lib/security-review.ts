/**
 * The security-review agent.
 *
 * NOT a discovered agent: this is a `createSecurityAgent(ref, octokit, sandbox)`
 * FACTORY (no default export) used by the `security-review` workflow, so it lives in
 * `src/agent-lib/` (not `src/agents/`) — Flue discovers every IMMEDIATE file in
 * `src/agents/` as an addressable agent (flue-reference §0 / PROGRESS DISCOVERY RULE),
 * so a non-default export there would be a phantom agent.
 *
 * Phase 5 (~/work/lastlight/workflows/security-review.yaml — `kind: health`, repo-scoped,
 * SANDBOXED; skill: security-review, model: {{models.security}}, variant: {{variants.security}}).
 * This is the STRUCTURAL SIBLING of `repo-health` (a repo-scoped scan with NO specific
 * issue/PR), but UNLIKE repo-health it is SANDBOXED: it reviews the ACTUAL code in a
 * checkout. The agent performs a security/SDLC review over the cloned repo and emits a
 * findings REPORT (markdown). The WORKFLOW files the dated summary issue deterministically
 * (src/security-review-post.ts) — see that module + the workflow for the reference deviation.
 *
 * Config mirrors the architect (the sandboxed-agent pattern):
 *   - READ-ONLY GitHub tools bound to (ref, token) — closed over, never model-selected
 *     (spec/09 security spine);
 *   - the `security-review` skill (the SDLC/diff review procedure + the machine-parsed
 *     issue-format contract that `security-feedback` consumes), surfaced by NAME;
 *   - the shared persona as `instructions` (loadPersona — incl. agent-context/security.md),
 *     anchoring the untrusted-content markers in the security prompt's repo snapshot;
 *   - model + thinkingLevel for the `security` task key (config / the reference's
 *     `{{models.security}}` + `{{variants.security}}` in security-review.yaml).
 *
 * SANDBOX (required, not additive): security-review ALWAYS runs WITH a Docker sandbox.
 * beta.3: the HARNESS owns the sandbox — this static agent declares
 * `sandbox: dockerSandbox()` + `cwd: /workspace`, so Flue stands an empty container
 * up at init; the WORKFLOW `run()` then clones the repo into `/workspace` via
 * `harness.shell` (`cloneRepoIntoHarness`). The container self-terminates (`--rm` +
 * ttl) — Flue offers no teardown hook (api/sandbox-api.md). The agent's bash/file
 * tools then review the checkout at `/workspace`.
 *
 * SCANNER-TOOLING DEVIATION (documented, not a blocker): the reference skill also shells
 * out to `gitleaks` + `semgrep`. The `node:22-bookworm` sandbox image lacks them AND
 * egress is still DEFERRED (no SSRF floor), so this slice does the LLM SDLC/diff review
 * ONLY — gitleaks/semgrep are a TODO(phase-9/egress + scanner-image), exactly as
 * repo-health deferred its Slack delivery. We do NOT apt-install scanners here.
 *
 * ⚠ EGRESS DEFERRED: the container runs with full network + no SSRF floor. Do NOT run
 * untrusted input through it. See PROGRESS.md / spec/09.
 */
import { defineAgent } from "@flue/runtime";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import { dockerSandbox } from "../sandboxes/docker.ts";
import securityReview from "../skills/security-review/SKILL.md" with { type: "skill" };

export const description =
  "Reviews a pre-cloned repo for SDLC/security concerns GitHub's scanners miss and emits a findings report; the workflow files the dated summary issue deterministically.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const SECURITY_TASK_KEY = "security" as const;

/** The working directory the repo is cloned into (matches docker.ts WORKSPACE). */
export const SECURITY_CWD = "/workspace" as const;

/**
 * The security-review agent definition (beta.3 static `defineAgent`, bound on the
 * `security-review` workflow). `sandbox: dockerSandbox()` gives the harness a fresh
 * self-terminating container; `cwd: /workspace` points the agent's bash/file tools at
 * the checkout the workflow clones in via `cloneRepoIntoHarness`. No GitHub write tool
 * is bound; per-run READ tools are injected per-call via `session.prompt(_, { tools })`,
 * and the summary issue is filed deterministically by the workflow.
 */
export const securityAgent = defineAgent(() => ({
  model: resolveModel(SECURITY_TASK_KEY),
  thinkingLevel: resolveThinking(SECURITY_TASK_KEY),
  instructions: loadPersona(),
  skills: [securityReview],
  sandbox: dockerSandbox(),
  cwd: SECURITY_CWD,
}));

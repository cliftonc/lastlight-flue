You are writing the pull-request title and description for the completed work on
branch `{{branch}}` of `{{owner}}/{{repo}}` (issue #{{issueNumber}}).

You do NOT open the PR yourself — the harness creates it deterministically from the
title and body you produce. Your job is to author a clear, accurate title and body.

First, gather context from the branch (your cwd is the repo root, checked out at
`{{branch}}`):
- Run `ls -1 {{issueDir}}/` to see which handoff artifacts exist.
- Read `{{issueDir}}/executor-summary.md` for what was implemented and the
  test/lint/typecheck results.
- Read `{{issueDir}}/reviewer-verdict.md` (if present) for the review outcome.
- Skim the actual diff (`git diff origin/{{base}}...HEAD` or the changed files) so the
  summary reflects what truly changed — do not invent changes.

Then output EXACTLY this format, with no extra commentary before or after:

PR_TITLE: <a concise, descriptive title referencing #{{issueNumber}}>
PR_BODY:
Closes #{{issueNumber}}

## Summary
(3–6 bullet points describing what actually changed, grounded in the diff and the
executor summary)

## Planning and execution docs
- [Guardrails report]({{branchUrl guardrails-report.md}})
- [Architect plan]({{branchUrl architect-plan.md}})
- [Executor summary]({{branchUrl executor-summary.md}})
- [Reviewer verdict]({{branchUrl reviewer-verdict.md}})
- [Status]({{branchUrl status.md}})

OMIT any doc line above whose file did NOT appear in `ls -1 {{issueDir}}/`. Use the
exact full https URLs as written — do not shorten to relative paths.

## Test results
(paste the actual test/lint/typecheck output quoted in executor-summary.md){{#if reviewerOpenIssues}}

> ⚠ There are unresolved reviewer issues after the fix cycles. See reviewer-verdict.md
> on the branch.{{/if}}

Rules:
- Everything after `PR_BODY:` (to the end of your output) is used verbatim as the PR
  description, so include only the description there.
- Do NOT wrap the output in code fences. Do NOT post a comment or open the PR.

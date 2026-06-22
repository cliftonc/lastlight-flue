/**
 * Untrusted-content delimiters + wrapper (ported from
 * `~/work/lastlight/src/engine/screen.ts`, the marker + `wrapUntrusted` subset).
 *
 * Issue / PR / comment text is UNTRUSTED (spec/07 invariant, spec/08): it must
 * reach an agent as DATA, never as instructions. Any user-provided text stitched
 * into a prompt's `contextSnapshot` is wrapped in
 * `<<<USER_CONTENT_UNTRUSTED ...>>> … <<<END_USER_CONTENT_UNTRUSTED>>>` markers.
 * The shared persona's `agent-context/security.md` anchors the agent to treat
 * anything inside these markers as data — so a hostile issue body can't smuggle
 * "ignore your instructions" past the architect.
 *
 * This is the wrap-only subset: the model-backed injection SCREENER
 * (`screen.ts` in the reference) is NOT ported here — the structural wrapper is
 * the load-bearing defense the architect prompt relies on. The screener is an
 * additive later-phase concern.
 *
 * Trigger metadata (sender, branch, issue ref) is established OUT of band — it
 * sits OUTSIDE the wrappers in the snapshot, so an identity claim from inside an
 * untrusted block carries no authority.
 */

/** Markers used to delimit untrusted user content inside agent prompts. */
export const UNTRUSTED_OPEN = "<<<USER_CONTENT_UNTRUSTED";
export const UNTRUSTED_CLOSE = "<<<END_USER_CONTENT_UNTRUSTED>>>";

/**
 * Wrap user-provided content with the untrusted-content delimiters referenced in
 * `agent-context/security.md`. Strips any PRE-EXISTING markers from the body so a
 * hostile message can't terminate the wrapper early and present its payload as if
 * it were outside (and therefore trusted).
 */
export function wrapUntrusted(
  body: string,
  meta: { source: string; author?: string } = { source: "unknown" },
): string {
  const sanitized = body
    .replaceAll(UNTRUSTED_OPEN, "<<<UCU")
    .replaceAll(UNTRUSTED_CLOSE, "END_UCU>>>");
  const attrs = [`source="${meta.source}"`];
  if (meta.author) attrs.push(`author="${meta.author}"`);
  return `${UNTRUSTED_OPEN} ${attrs.join(" ")}>>>\n${sanitized}\n${UNTRUSTED_CLOSE}`;
}

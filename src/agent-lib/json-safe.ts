/**
 * `jsonSafe` — recursively strip `undefined` from a workflow's return value so it is
 * always Flue-JSON-serializable.
 *
 * WHY (the bug this guards): Flue's Action output serializer (`assertJsonLike`) REJECTS
 * any `undefined` nested inside the returned object/array — it throws
 * `ActionOutputSerializationError` ("output.X must not contain undefined values") and
 * FAILS THE WHOLE RUN, even when the workflow's real work already succeeded. A single
 * optional field left undefined (e.g. issue-triage's `commentUrl?` when the triage
 * neither commented nor closed) crashed the run + orphaned it. A workflow result is
 * NOT a hand-built JSON literal — it carries optional fields straight from API
 * responses — so this is easy to hit and must fail gracefully, not nuke the run.
 *
 * Behavior mirrors `JSON.stringify` semantics: object keys whose value is `undefined`
 * are DROPPED; `undefined` array elements become `null` (as `JSON.stringify` does);
 * `null`, primitives, and nested structures are preserved. Apply at every workflow
 * `run()` return: `return jsonSafe(await runX(...)) as unknown as JsonValue`.
 *
 * Lives in `src/agent-lib/` (NOT discovered).
 */
export function jsonSafe<T>(value: T): T {
  return stripUndefined(value) as T;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : stripUndefined(v)));
  }
  if (value !== null && typeof value === "object") {
    // Preserve only own enumerable data props; drop undefined-valued keys.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

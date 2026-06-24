// Shared agent persona — the single `instructions` string handed to EVERY role
// agent (workflow + chat). It concatenates the canonical `agent-context/*.md`
// files so there is ONE persona source, no bifurcation between surfaces.
//
// `security.md` is the untrusted-content rule that pairs with the later
// contextSnapshot wrapping (spec/07) — it is simply included here; no special
// logic is needed at this layer.
//
// Behaviour matches the reference `loadAgentContext()`
// (~/work/lastlight/src/workflows/loader.ts): the `.md` files are concatenated
// in ALPHABETICAL filename order (rules → security → soul) and joined with a
// `\n\n---\n\n` separator.
//
// The three files are imported with `with { type: 'markdown' }` so Flue INLINES
// their contents as strings at BUILD time (see flue-reference §0 + the
// "Markdown instructions" section of guide/building-agents.md). This is the
// same build-time mechanism skills use (`with { type: 'skill' }`). It replaces
// the previous `readFileSync(import.meta.url-derived path)` runtime read, which
// broke under `flue build`: persona.ts is inlined into `dist/server.mjs`, so
// `import.meta.url` resolved to `dist/` and the files were neither there nor
// shipped — every persona-using agent crashed at runtime with ENOENT. No
// fs/path/import.meta.url reads happen here anymore.

import rules from '../agent-context/rules.md' with { type: 'markdown' };
import security from '../agent-context/security.md' with { type: 'markdown' };
import soul from '../agent-context/soul.md' with { type: 'markdown' };
import { FLUE_RUNTIME_VERSION, FLUE_VERSION_TOKEN } from './runtime-identity.ts';

// The canonical persona files, in the order the reference loader emits them
// (alphabetical filename sort): rules → security → soul. Keep this list explicit
// so the loader is deterministic.
const PERSONA_PARTS = [rules, security, soul] as const;

const SEPARATOR = '\n\n---\n\n';

export interface LoadPersonaOptions {
  /**
   * Optional text appended after the persona body (separated by the same
   * `\n\n---\n\n` separator). The chat agent uses this for its chat suffix
   * (spec/11); workflow agents omit it.
   */
  suffix?: string;
}

/**
 * Build the shared agent persona / `instructions` string from
 * `agent-context/{rules,security,soul}.md` (inlined at build time).
 *
 * @returns the concatenated persona, optionally with `opts.suffix` appended.
 */
export function loadPersona(opts: LoadPersonaOptions = {}): string {
  let persona = PERSONA_PARTS.map((part) => part.trim()).join(SEPARATOR);

  const suffix = opts.suffix?.trim();
  if (suffix) {
    persona += SEPARATOR + suffix;
  }

  // Fill soul.md's `{{FLUE_VERSION}}` token with the live runtime version so the
  // agent can state which Flue it runs on when asked (the version is build-inlined
  // from our `@flue/runtime` pin — see runtime-identity.ts).
  return persona.split(FLUE_VERSION_TOKEN).join(FLUE_RUNTIME_VERSION);
}

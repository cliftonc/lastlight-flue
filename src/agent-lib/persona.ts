import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
// `\n\n---\n\n` separator. Reading from disk via fs (path resolved relative to
// this module) keeps the loader unit-testable offline with no build step.

const HERE = dirname(fileURLToPath(import.meta.url));
// agents/persona.ts → ../agent-context (copied under src/ so it travels with the
// authored source; see PROGRESS for the deviation from the design's root layout).
const AGENT_CONTEXT_DIR = join(HERE, '..', 'agent-context');

// The canonical persona files, in the order the reference loader emits them
// (alphabetical filename sort). Keep this list explicit so the loader is
// deterministic and does not depend on directory enumeration order.
const PERSONA_FILES = ['rules.md', 'security.md', 'soul.md'] as const;

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
 * `agent-context/{rules,security,soul}.md`.
 *
 * @returns the concatenated persona, optionally with `opts.suffix` appended.
 */
export function loadPersona(opts: LoadPersonaOptions = {}): string {
  const parts = PERSONA_FILES.map((name) =>
    readFileSync(join(AGENT_CONTEXT_DIR, name), 'utf-8').trim(),
  );

  let persona = parts.join(SEPARATOR);

  const suffix = opts.suffix?.trim();
  if (suffix) {
    persona += SEPARATOR + suffix;
  }

  return persona;
}

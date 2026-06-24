// The agent's runtime self-identity — the Flue version it runs on.
//
// Sourced from OUR `package.json` `@flue/runtime` dependency pin (an EXACT pin,
// e.g. `1.0.0-beta.3`). `@flue/runtime` does not export its own `package.json`
// (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so the pin is the single source of truth and
// stays in sync automatically on a dependency bump. The JSON import is INLINED at
// build time (like the persona markdown), so there is no runtime fs read.
import pkg from "../../package.json" with { type: "json" };

/** The pinned `@flue/runtime` version (e.g. `1.0.0-beta.3`), or `unknown`. */
export const FLUE_RUNTIME_VERSION: string =
  (pkg as { dependencies?: Record<string, string> }).dependencies?.["@flue/runtime"] ??
  "unknown";

/** The `{{FLUE_VERSION}}` token in `soul.md`, replaced by `loadPersona`. */
export const FLUE_VERSION_TOKEN = "{{FLUE_VERSION}}";

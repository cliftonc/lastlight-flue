import { getPublicConfig, type PublicConfigBundle } from '../config.ts';

// ── Last Light on Flue · admin config seam (config + provenance) ──────────────
//
// The data layer backing `GET /admin/api/config`. The dashboard's Default /
// Overlay / Merged view (dashboard/src/api.ts `ConfigBundle`) wants the four-part
// `{ default, overlay, merged, sources }` bundle: the raw default-YAML tree, the
// optional overlay tree, the effective merged tree, and a provenance mirror whose
// leaves say WHICH layer ("default" | "overlay" | "env") supplied each value.
//
// Flue's config resolution already tracks all four. `src/config.ts` builds the
// merged tree + provenance via the uniform precedence pass in
// `src/config-resolve.ts` (env > overlay > default, leaf-by-leaf) and exposes the
// finished, secret-REDACTED bundle as `config.publicConfig` — the exact shape the
// reference's `config.publicConfig` carried. So this reader is a THIN seam over
// `getPublicConfig()`; the provenance ('sources') is REAL (derived during the
// merge in `resolveConfigLayers`), never a best-effort approximation.
//
// Behind an INJECTABLE seam (`ConfigReader`, like `StatsReader`/`RunsReader`): the
// default reads the loaded runtime config (loading it on first call); tests inject
// a fake bundle and run fully offline with no YAML/env on disk.

/**
 * The `GET /admin/api/config` response — the dashboard's `ConfigBundle`
 * (dashboard/src/api.ts). `sources` mirrors `merged`; object nodes stay nested
 * and leaves are the layer that supplied the effective value.
 */
export type ConfigBundle = PublicConfigBundle;

/** The injectable seam `createApp()` mounts the config route over. */
export interface ConfigReader {
  /** The four-part config bundle (default / overlay / merged / sources). */
  bundle(): ConfigBundle;
}

/**
 * The production config reader: returns Flue's already-resolved, secret-redacted
 * public config bundle (`getPublicConfig()`), which loads the config from
 * config/default.yaml + the optional overlay + env on first access and memoizes
 * it. The provenance tree is the REAL one computed during resolution, not derived
 * after the fact.
 */
export function createDefaultConfigReader(
  opts: { load?: () => ConfigBundle } = {},
): ConfigReader {
  const load = opts.load ?? getPublicConfig;
  return {
    bundle: () => load(),
  };
}

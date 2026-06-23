import { describe, it, expect } from 'vitest';
import {
  createDefaultConfigReader,
  type ConfigBundle,
} from './config-reader.ts';

// Pure unit tests for the config seam. No YAML/env on disk: a fake `load`
// supplies a sample bundle, so we pin the four-part `{ default, overlay, merged,
// sources }` shape (the dashboard `ConfigBundle`) and the provenance tree the
// route serves verbatim.

const sample: ConfigBundle = {
  default: { models: { default: 'openai/gpt-5.1' }, sandbox: { backend: 'none' } },
  overlay: { models: { default: 'anthropic/claude' } },
  merged: { models: { default: 'anthropic/claude' }, sandbox: { backend: 'none' } },
  sources: { models: { default: 'overlay' }, sandbox: { backend: 'default' } },
};

describe('createDefaultConfigReader (injected load)', () => {
  it('returns the four-part bundle verbatim', () => {
    const reader = createDefaultConfigReader({ load: () => sample });
    expect(reader.bundle()).toEqual(sample);
  });

  it('carries the provenance tree mirroring merged (leaves = source layer)', () => {
    const reader = createDefaultConfigReader({ load: () => sample });
    const b = reader.bundle();
    expect(b.sources).toEqual({
      models: { default: 'overlay' },
      sandbox: { backend: 'default' },
    });
    // sources mirrors merged structurally (object nodes nested, leaves scalar).
    expect(Object.keys(b.sources)).toEqual(Object.keys(b.merged));
  });

  it('passes through a null overlay (no overlay configured)', () => {
    const noOverlay: ConfigBundle = { ...sample, overlay: null };
    const reader = createDefaultConfigReader({ load: () => noOverlay });
    expect(reader.bundle().overlay).toBeNull();
  });

  it('reads on every call (no internal caching of its own)', () => {
    let n = 0;
    const reader = createDefaultConfigReader({
      load: () => ({ ...sample, default: { n: ++n } }),
    });
    expect((reader.bundle().default as { n: number }).n).toBe(1);
    expect((reader.bundle().default as { n: number }).n).toBe(2);
  });
});

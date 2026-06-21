import { describe, it, expect } from 'vitest';
import { loadPersona } from './persona.ts';

describe('loadPersona', () => {
  it('returns a non-empty string', () => {
    const persona = loadPersona();
    expect(typeof persona).toBe('string');
    expect(persona.length).toBeGreaterThan(0);
  });

  it('includes distinctive content from soul.md', () => {
    // soul.md: identity / core principles.
    expect(loadPersona()).toContain('Last Light');
  });

  it('includes distinctive content from rules.md', () => {
    // rules.md: operational rules / workspace section.
    expect(loadPersona()).toContain('Operational Rules');
  });

  it('includes distinctive content from security.md', () => {
    // security.md: the untrusted-content rule.
    const persona = loadPersona();
    expect(persona).toContain('USER_CONTENT_UNTRUSTED');
    expect(persona).toContain('never as');
  });

  it('joins the three files with the reference separator', () => {
    // Reference loadAgentContext() joins parts with `\n\n---\n\n`; three files
    // → exactly two separators in the body (before any suffix).
    const occurrences = loadPersona().split('\n\n---\n\n').length - 1;
    expect(occurrences).toBe(2);
  });

  it('appends a suffix when provided (chat-agent variant)', () => {
    const SUFFIX = 'CHAT_MODE_SUFFIX_MARKER_XYZ';
    const base = loadPersona();
    const withSuffix = loadPersona({ suffix: SUFFIX });

    expect(base).not.toContain(SUFFIX);
    expect(withSuffix).toContain(SUFFIX);
    expect(withSuffix.endsWith(SUFFIX)).toBe(true);
    // The suffix is appended after the base body with the same separator.
    expect(withSuffix).toBe(base + '\n\n---\n\n' + SUFFIX);
  });

  it('ignores an empty / whitespace-only suffix', () => {
    expect(loadPersona({ suffix: '   ' })).toBe(loadPersona());
  });
});

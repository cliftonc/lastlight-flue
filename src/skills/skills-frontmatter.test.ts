import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// SKILL.md frontmatter audit — the Phase-1 "every SKILL.md parses" acceptance
// criterion (design/phase-1-shared-core.md → Skills). Replaces the reference's
// prod "silent drop" of a malformed skill with a test that fails the build.
//
// Flue validates SKILL.md against the Agent Skills spec (name + description are
// the two REQUIRED fields; version/tags are present on most but NOT all of the
// ported skills — e.g. `chat` carries only name + description — so we only
// assert the universally-present required fields here).

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = HERE; // this test lives in src/skills/

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

function skillDirs(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((name) => {
      const full = join(SKILLS_DIR, name);
      try {
        return statSync(full).isDirectory() && statSync(join(full, 'SKILL.md')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function parseFrontmatter(skillName: string): Record<string, unknown> {
  const raw = readFileSync(join(SKILLS_DIR, skillName, 'SKILL.md'), 'utf-8');
  const match = FRONTMATTER_RE.exec(raw);
  const body = match?.[1];
  expect(body, `${skillName}/SKILL.md is missing YAML frontmatter`).toBeTruthy();
  const fm = parseYaml(body!);
  expect(typeof fm, `${skillName}/SKILL.md frontmatter did not parse to an object`).toBe('object');
  return fm as Record<string, unknown>;
}

describe('SKILL.md frontmatter audit', () => {
  const dirs = skillDirs();

  it('finds exactly 12 skills', () => {
    expect(dirs).toHaveLength(12);
  });

  it.each(dirs)('%s/SKILL.md parses with a non-empty name and description', (skill) => {
    const fm = parseFrontmatter(skill);

    expect(typeof fm.name, `${skill}: name must be a string`).toBe('string');
    expect((fm.name as string).trim().length, `${skill}: name must be non-empty`).toBeGreaterThan(0);

    expect(typeof fm.description, `${skill}: description must be a string`).toBe('string');
    expect(
      (fm.description as string).trim().length,
      `${skill}: description must be non-empty`,
    ).toBeGreaterThan(0);
  });

  it('declares each skill name matching its directory (Flue requirement)', () => {
    // Flue validates that frontmatter `name` matches the skill directory name.
    for (const skill of dirs) {
      const fm = parseFrontmatter(skill);
      expect(fm.name, `${skill}: frontmatter name must match directory name`).toBe(skill);
    }
  });
});

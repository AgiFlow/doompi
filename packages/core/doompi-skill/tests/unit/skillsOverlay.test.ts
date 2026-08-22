import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { SkillsOverlayComponent, type SkillsOverlayResult, skillBody } from '../../src/tui/skillsOverlay.ts';
import type { SkillCatalog, SkillEntry } from '../../src/adapters/skillCatalog.ts';

/** Identity theme so assertions read as plain text, per doom-pi-ui's rendering suite. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const REPO_ROOT = '/repo';
const WIDE = 140;
const NARROW = 40;
const KEY_DOWN = '\x1b[B';
const KEY_UP = '\x1b[A';
const KEY_LEFT = '\x1b[D';
const KEY_RIGHT = '\x1b[C';
const KEY_ENTER = '\r';
const KEY_ESCAPE = '\x1b';
const KEY_TAB = '\t';
const SKILL_FILE = '---\nname: x\n---\n\nBody line.\n';
const TREE_HEADING = 'CATALOG';
/** The detail pane opens on a skill, since headings cannot take the selection. */
const FIRST_SKILL = 'workflow-recovery';

function createTui(rows = 40, columns = WIDE): TUI {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as unknown as TUI;
}

function skill(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description: `Does ${name}.`,
    filePath: `/repo/plugins/development/skills/${name}/SKILL.md`,
    baseDir: `/repo/plugins/development/skills/${name}`,
    group: 'plugins',
    owner: 'development',
    modelInvocable: true,
    ...overrides,
  };
}

function catalog(): SkillCatalog {
  const recovery = skill(FIRST_SKILL, {
    group: 'extensions',
    owner: '@agimon-ai/doompi-workflow',
    filePath: '/repo/packages/minor/doompi-workflow/skills/workflow-recovery/SKILL.md',
  });
  const shared = skill('git-commit', {
    group: 'default',
    owner: '.claude/skills',
    filePath: '/repo/.claude/skills/git-commit/SKILL.md',
  });
  return {
    groups: [
      {
        key: 'extensions',
        label: 'extensions',
        owners: [{ owner: '@agimon-ai/doompi-workflow', skills: [recovery] }],
      },
      {
        key: 'plugins',
        label: 'plugins',
        owners: [{ owner: 'development', skills: [skill('backend'), skill('frontend')] }],
      },
      {
        key: 'default',
        label: 'default',
        owners: [{ owner: '.claude/skills', skills: [shared] }],
      },
    ],
    skillCount: 4,
    promptTokens: 420,
    bodyTokens: 18_600,
    diagnostics: [],
  };
}

function build(readFile: () => string = () => SKILL_FILE) {
  const done = vi.fn<(result: SkillsOverlayResult) => void>();
  const component = new SkillsOverlayComponent(
    createTui(),
    theme,
    { catalog: catalog(), repoRoot: REPO_ROOT, readFile },
    done,
  );
  return { component, done };
}

function text(component: SkillsOverlayComponent, width = WIDE): string {
  return component.render(width).join('\n');
}

describe('skillBody', () => {
  it('drops frontmatter and leading blank lines', () => {
    expect(skillBody('---\nname: a\n---\n\nFirst line.\n')).toBe('First line.\n');
  });

  it('returns the content unchanged when there is no frontmatter', () => {
    expect(skillBody('Just prose.')).toBe('Just prose.');
  });
});

describe('SkillsOverlayComponent', () => {
  it('opens with every group, owner and skill already visible', () => {
    const rendered = text(build().component);

    for (const label of [
      'extensions',
      '@agimon-ai/doompi-workflow',
      FIRST_SKILL,
      'plugins',
      'development',
      'backend',
      'frontend',
      'default',
      '.claude/skills',
      'git-commit',
    ]) {
      expect(rendered).toContain(label);
    }
  });

  it('draws no fold glyphs and offers no fold hint', () => {
    const rendered = text(build().component);

    expect(rendered).not.toContain('▸');
    expect(rendered).not.toContain('▾');
    expect(rendered).not.toContain('fold');
  });

  it('opens with the first skill selected rather than a heading', () => {
    expect(text(build().component)).toContain('/skill:workflow-recovery');
  });

  it('steps over the owner and group headings between skills', () => {
    const { component } = build();
    // One step from the last extensions skill lands on `backend`, which sits two
    // heading rows below it in the tree.
    component.handleInput(KEY_DOWN);

    expect(text(component)).toContain('/skill:backend');
  });

  it('never selects past the last skill', () => {
    const { component } = build();
    for (let index = 0; index < 20; index += 1) component.handleInput(KEY_DOWN);

    expect(text(component)).toContain('/skill:git-commit');
  });

  it('never selects before the first skill', () => {
    const { component } = build();
    for (let index = 0; index < 5; index += 1) component.handleInput(KEY_UP);

    expect(text(component)).toContain('/skill:workflow-recovery');
  });

  it('ignores the fold keys', () => {
    const { component, done } = build();
    const before = text(component);
    component.handleInput(KEY_LEFT);
    component.handleInput(KEY_RIGHT);

    expect(text(component)).toBe(before);
    expect(done).not.toHaveBeenCalled();
  });

  it('resolves with the selected skill on enter', () => {
    const { component, done } = build();
    component.handleInput(KEY_ENTER);

    expect(done).toHaveBeenCalledWith({
      kind: 'invoke',
      skill: expect.objectContaining({ name: FIRST_SKILL }),
    });
  });

  it('closes on escape', () => {
    const { component, done } = build();
    component.handleInput(KEY_ESCAPE);

    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('renders the detail pane for the selected skill', () => {
    const rendered = text(build().component);

    expect(rendered).toContain('description');
    expect(rendered).toContain('invocable');
    expect(rendered).toContain('/skill:workflow-recovery');
    expect(rendered).toContain('Body line.');
  });

  it('renders a repo-relative path in the detail pane', () => {
    expect(text(build().component)).toContain('packages/minor/doompi-workflow/skills/workflow-recovery/SKILL.md');
  });

  it('survives a SKILL.md that cannot be read', () => {
    const { component } = build(() => {
      throw new Error('gone');
    });

    expect(text(component)).toContain('Could not read SKILL.md.');
  });

  it('narrows the tree to matches while filtering', () => {
    const { component } = build();
    component.handleInput('/');
    for (const character of 'frontend') component.handleInput(character);
    const rendered = text(component);

    expect(rendered).toContain('frontend');
    expect(rendered).not.toContain(FIRST_SKILL);
  });

  it('clears the filter on escape instead of closing', () => {
    const { component, done } = build();
    component.handleInput('/');
    component.handleInput('f');
    component.handleInput(KEY_ESCAPE);

    expect(done).not.toHaveBeenCalled();
    expect(text(component)).toContain('development');
  });

  it('switches the footer hints when the body takes focus', () => {
    const { component } = build();
    expect(text(component)).toContain('use skill');

    component.handleInput(KEY_TAB);
    expect(text(component)).toContain('scroll');
  });

  it('puts the tree and the detail on one row at full width', () => {
    const lines = build().component.render(WIDE);

    expect(lines.some((line) => line.includes(TREE_HEADING) && line.includes(FIRST_SKILL))).toBe(true);
  });

  it('stacks the panes below the two-pane width', () => {
    const lines = build().component.render(NARROW);

    // The frame draws its own verticals, so the split shows as two panes
    // sharing a row rather than as the absence of a divider glyph.
    expect(lines.some((line) => line.includes(TREE_HEADING) && line.includes('description'))).toBe(false);
    expect(lines.some((line) => line.includes('description'))).toBe(true);
  });

  it('reports the skill count and token cost in the header', () => {
    expect(text(build().component)).toContain('4 skills · 3 sources · 420 always-on · 19k full');
  });
});

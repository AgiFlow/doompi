import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doomPromptShape } from '../../src/rules/prompts.js';

const boundaryContext = () => ({ boundary: null });

describe('Doom prompt shape rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-prompts-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, source: string): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, 'utf8');
    return filePath;
  }

  function writeManifest(files: string[] = ['dist', 'src/prompts']): string {
    return write('package.json', JSON.stringify({ files }));
  }

  function writePrompt(name: string, description = 'Guide DoomPi authors.'): void {
    write(`src/prompts/${name}/SKILL.md`, `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`);
  }

  it('accepts published, indexed prompts with standard support folders', () => {
    const manifest = writeManifest();
    writePrompt('doompi-author-hook');
    write('src/prompts/doompi-author-hook/references/events.md', '# Events\n');
    write('src/prompts/doompi-author-hook/scripts/validate.mjs', 'export const valid = true;\n');
    write('src/prompts/doompi-author-hook/assets/example.yaml', 'hooks: {}\n');
    write('src/prompts/doompi-author-hook/agents/openai.yaml', 'name: helper\n');
    write('llms.txt', '# Hook\n\n- [Author hooks](./src/prompts/doompi-author-hook/SKILL.md)\n');

    expect(doomPromptShape.check?.(manifest, root, boundaryContext())).toBeNull();
  });

  it('requires an exact publish allowlist entry and llms.txt link', () => {
    const manifest = writeManifest(['dist', 'src/prompts/**']);
    writePrompt('doompi-use-voice');
    write('llms.txt', '# Voice\n');

    const result = doomPromptShape.check?.(manifest, root, boundaryContext());

    expect(result).toContain('package.json files must contain exact entry "src/prompts"');
    expect(result).toContain('llms.txt must link src/prompts/doompi-use-voice/SKILL.md');
  });

  it('reports missing indexes and malformed prompt directory contents', () => {
    const manifest = writeManifest();
    writePrompt('Bad_Name');
    write('src/prompts/Bad_Name/references/SKILL.md', '---\nname: nested\ndescription: nested\n---\n');
    write('src/prompts/loose.md', '# loose\n');

    const result = doomPromptShape.check?.(manifest, root, boundaryContext());

    expect(result).toContain('llms.txt is required');
    expect(result).toContain('prompt directory must be kebab-case: src/prompts/Bad_Name');
    expect(result).toContain('src/prompts/Bad_Name must contain exactly one direct SKILL.md');
    expect(result).toContain('unexpected direct file src/prompts/loose.md');
  });

  it('requires matching name and nonempty description frontmatter', () => {
    const manifest = writeManifest();
    write('src/prompts/doompi-author-domain/SKILL.md', '---\nname: another-name\ndescription: ""\n---\n\n# Domain\n');
    write('llms.txt', '- [Domain](src/prompts/doompi-author-domain/SKILL.md)\n');

    const result = doomPromptShape.check?.(manifest, root, boundaryContext());

    expect(result).toContain('frontmatter name must equal doompi-author-domain');
    expect(result).toContain('frontmatter description must be nonempty');
  });

  it('ignores packages without src/prompts and package-root runtime skills', () => {
    const manifest = writeManifest(['dist', 'skills']);
    write('skills/doom-runner/SKILL.md', '---\nname: doom-runner\ndescription: Run jobs.\n---\n');

    expect(doomPromptShape.check?.(manifest, root, boundaryContext())).toBeNull();
    expect(doomPromptShape.check?.(path.join(root, 'skills/doom-runner/SKILL.md'), root, boundaryContext())).toBeNull();
  });

  it('reports absent and unterminated frontmatter', () => {
    const manifest = writeManifest();
    write('src/prompts/doompi-use-plan/SKILL.md', '# Plan\n');
    write('llms.txt', '- [Plan](./src/prompts/doompi-use-plan/SKILL.md)\n');

    expect(doomPromptShape.check?.(manifest, root, boundaryContext())).toContain('must start with YAML frontmatter');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webPluginToolRenderers } from '../../src/rules/webPluginTools.js';

const CONTRACTS = '@agimon-ai/doompi-web-contracts';

describe('web-plugin-tool-renderers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-plugin-tools-'));
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

  function manifest(withPlugin = true): string {
    return write(
      'package.json',
      JSON.stringify({
        name: 'p',
        ...(withPlugin ? { doompiWeb: { pluginId: 'demo', client: './web/index.ts' } } : {}),
      }),
    );
  }

  const tool = (name: string) => `pi.registerTool({ name: ${name}, parameters: {}, async execute() { return {}; } });`;
  const entry = (tools: string, extra = '') =>
    `import { defineWebPlugin } from '${CONTRACTS}';\nexport const webPlugin = defineWebPlugin({ id: 'demo', toolRenderers: [{ tools: ${tools}, ${extra}message: X }] });`;

  it('is silent off the manifest and for a package that registers no tool', () => {
    write('src/adapters/pi/tool.ts', tool("'read'"));
    expect(webPluginToolRenderers.check?.(write('web/index.ts', entry("['read']")), root)).toBeNull();
    const clean = manifest();
    write('src/adapters/pi/tool.ts', "voiceTools.register({ name: 'x', inputSchema: {}, execute() {} });");
    write(
      'src/services/modes.ts',
      "catalog.registerOwner({ descriptor: { id: 'plan', actions: [{ id: 'go', parameters: [] }] } });",
    );
    expect(webPluginToolRenderers.check?.(clean, root)).toBeNull();
  });

  it('accepts a literal name claimed by a literal tools entry', () => {
    const file = manifest();
    write('src/adapters/pi/tool.ts', tool("'read'"));
    write('web/index.ts', entry("['read']"));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('resolves same-file consts, relative src imports, and const arrays spread into the claim', () => {
    const file = manifest();
    write('src/schemas/bash.ts', "export const BASH_TOOL_NAME = 'bash';");
    write(
      'src/commands/bashTool.ts',
      `import { BASH_TOOL_NAME } from '../schemas/bash.js';\nconst TASK = 'task' as const;\n${tool('BASH_TOOL_NAME')}\n${tool('TASK')}`,
    );
    write('web/names.ts', "const BASH = 'bash';\nexport const TOOL_NAMES = [BASH, 'task'] as const;");
    write(
      'web/index.ts',
      `import { defineWebPlugin } from '${CONTRACTS}';\nimport { TOOL_NAMES } from './names.ts';\nexport const webPlugin = defineWebPlugin({ id: 'demo', toolRenderers: [{ tools: [...TOOL_NAMES], message: X }] });`,
    );
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('resolves names taken by destructuring a string array declared locally or imported from src', () => {
    const file = manifest();
    write(
      'src/schemas/names.ts',
      "export const WORKFLOW_PI_TOOL_NAMES = ['list_workflows', 'launch_workflow'] as const;",
    );
    write(
      'src/adapters/pi/tools.ts',
      `import { WORKFLOW_PI_TOOL_NAMES } from '../../schemas/names.ts';\nconst [LIST, LAUNCH] = WORKFLOW_PI_TOOL_NAMES;\nconst [RUN] = ['workflow_run'] as const;\n${tool('LIST')}\n${tool('LAUNCH')}\n${tool('RUN')}`,
    );
    write('web/index.ts', entry("['list_workflows', 'launch_workflow', 'workflow_run']"));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
    write('web/index.ts', entry("['list_workflows']"));
    const result = webPluginToolRenderers.check?.(file, root);
    expect(result).toContain('launch_workflow (src/adapters/pi/tools.ts)');
    expect(result).toContain('workflow_run (src/adapters/pi/tools.ts)');
  });

  it('reports an unclaimed tool with the file that registers it', () => {
    const file = manifest();
    write('src/adapters/pi/tool.ts', `${tool("'read'")}\n${tool("'write'")}`);
    write('web/index.ts', entry("['read']"));
    const result = webPluginToolRenderers.check?.(file, root);
    expect(result).toContain('write (src/adapters/pi/tool.ts)');
    expect(result).not.toContain('read (');
    expect(result).toContain('toolRenderers');
  });

  it('requires a matches renderer for a name computed at runtime', () => {
    const file = manifest();
    write('src/adapters/pi/tool.ts', tool('tool.piName'));
    write('web/index.ts', entry('[]'));
    expect(webPluginToolRenderers.check?.(file, root)).toContain('computed at runtime');
    write('web/index.ts', entry('[]', 'matches: () => true, '));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('skips a name imported from another package, and lists it only beside a real miss', () => {
    const file = manifest();
    write(
      'src/adapters/pi/tool.ts',
      `import { NARRATE_TOOL_NAME } from '@agimon-ai/doompi-extension-contracts/voice-tools';\n${tool('NARRATE_TOOL_NAME')}`,
    );
    write('web/index.ts', entry("['narrate']"));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
    write('src/adapters/pi/other.ts', tool("'other'"));
    const result = webPluginToolRenderers.check?.(file, root);
    expect(result).toContain('other (src/adapters/pi/other.ts)');
    expect(result).toContain('Not checked (name imported from a package): NARRATE_TOOL_NAME');
  });

  it('honours the ignore marker beside a definition', () => {
    const file = manifest();
    write(
      'src/adapters/pi/child.ts',
      `// web-plugin-tool-renderers: ignore structured_output (child process only)\n${tool("'structured_output'")}`,
    );
    write('web/index.ts', entry('[]'));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('ignores test files and fixtures under src', () => {
    const file = manifest();
    write('src/adapters/pi/tool.test.ts', tool("'ghost'"));
    write('src/fixtures/tool.ts', tool("'ghost'"));
    write('web/index.ts', entry('[]'));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('asks for a web plugin when tools are registered and none is declared', () => {
    const file = manifest(false);
    write('src/adapters/pi/tool.ts', tool("'read'"));
    expect(webPluginToolRenderers.check?.(file, root)).toContain('scaffold-doom-web-plugin');
  });

  it('reads a contribution array kept in a sibling web module', () => {
    const file = manifest();
    write('src/adapters/pi/tool.ts', `${tool("'subagent'")}\n${tool("'intercom'")}`);
    write(
      'web/toolRenderers.ts',
      "export const teamToolRenderers = [{ tools: ['subagent'], message: A }, { tools: ['intercom'], message: B }];",
    );
    write(
      'web/index.ts',
      `import { defineWebPlugin } from '${CONTRACTS}';\nimport { teamToolRenderers } from './toolRenderers.ts';\nexport const webPlugin = defineWebPlugin({ id: 'demo', toolRenderers: teamToolRenderers });`,
    );
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });
});

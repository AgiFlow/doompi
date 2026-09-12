import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webPluginToolRenderers } from '../../src/rules/webPluginTools.js';

const CONTRACTS = '@agimon-ai/doompi-core/web';

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
        ...(withPlugin ? { doompiWeb: { pluginId: 'demo', client: './src/web/index.ts' } } : {}),
      }),
    );
  }

  const tool = (name: string) => `pi.registerTool({ name: ${name}, parameters: {}, async execute() { return {}; } });`;
  const entry = (tools: string, extra = '') =>
    `import { defineWebPlugin } from '${CONTRACTS}';\nexport const webPlugin = defineWebPlugin({ id: 'demo', toolRenderers: [{ tools: ${tools}, ${extra}message: X }] });`;

  it('exempts generic contract helper registration only at its owned controller paths', () => {
    const file = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-core' }));
    write('src/controllers/piExtension.ts', tool('item.name'));
    write('src/controllers/serverPlugin.ts', tool('item.name'));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
    expect(webPluginToolRenderers.check?.(file, root)).toContain('ships no doompiWeb');
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-core' }));
    write('src/controllers/unowned.ts', tool("'other'"));
    expect(webPluginToolRenderers.check?.(file, root)).toContain('ships no doompiWeb');
  });

  const nativePath = 'src/controllers/headlessSessionHost.ts';
  const projection = `function adapt(tool: HeadlessTool): AgentHarnessTool<object> {
    return { name: tool.name, parameters: tool.parameters, async execute() { return tool.execute(); } };
  }`;

  it('leaves renderer ownership with the originating packages for core native tool projection', () => {
    const file = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
    write(nativePath, projection);
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
    write('src/tools/owned.ts', tool("'owned'"));
    expect(webPluginToolRenderers.check?.(file, root)).toContain('owned');
  });

  it.each([
    ['another package', 'p', nativePath, projection],
    ['another core module', '@agimon-ai/doompi', 'src/tools/tool.ts', projection],
    [
      'a newly named core tool',
      '@agimon-ai/doompi',
      nativePath,
      projection.replace('name: tool.name', "name: 'owned'"),
    ],
    [
      'a changed schema',
      '@agimon-ai/doompi',
      nativePath,
      projection.replace('parameters: tool.parameters', 'parameters: {}'),
    ],
    [
      'different input ownership',
      '@agimon-ai/doompi',
      nativePath,
      projection.replace('parameters: tool.parameters', 'parameters: other.parameters'),
    ],
    [
      'a Pi return type',
      '@agimon-ai/doompi',
      nativePath,
      projection.replace('AgentHarnessTool<object>', 'ToolDefinition'),
    ],
  ])('still requires renderers for %s', (_label, packageName, filePath, source) => {
    const file = write('package.json', JSON.stringify({ name: packageName }));
    write(filePath, source);
    expect(webPluginToolRenderers.check?.(file, root)).not.toBeNull();
  });

  it('is silent off the manifest and for a package that registers no tool', () => {
    write('src/tools/tool.ts', tool("'read'"));
    expect(webPluginToolRenderers.check?.(write('src/web/index.ts', entry("['read']")), root)).toBeNull();
    const clean = manifest();
    write('src/tools/tool.ts', "voiceTools.register({ name: 'x', inputSchema: {}, execute() {} });");
    write(
      'src/services/modes.ts',
      "catalog.registerOwner({ descriptor: { id: 'plan', actions: [{ id: 'go', parameters: [] }] } });",
    );
    expect(webPluginToolRenderers.check?.(clean, root)).toBeNull();
  });

  it('accepts a literal name claimed by a literal tools entry', () => {
    const file = manifest();
    write('src/tools/tool.ts', tool("'read'"));
    write('src/web/index.ts', entry("['read']"));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('resolves same-file consts, relative src imports, and const arrays spread into the claim', () => {
    const file = manifest();
    write('src/schemas/bash.ts', "export const BASH_TOOL_NAME = 'bash';");
    write(
      'src/commands/bashTool.ts',
      `import { BASH_TOOL_NAME } from '../schemas/bash.js';\nconst TASK = 'task' as const;\n${tool('BASH_TOOL_NAME')}\n${tool('TASK')}`,
    );
    write('src/web/names.ts', "const BASH = 'bash';\nexport const TOOL_NAMES = [BASH, 'task'] as const;");
    write(
      'src/web/index.ts',
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
      'src/tools/tools.ts',
      `import { WORKFLOW_PI_TOOL_NAMES } from '../schemas/names';\nconst [LIST, LAUNCH] = WORKFLOW_PI_TOOL_NAMES;\nconst [RUN] = ['workflow_run'] as const;\n${tool('LIST')}\n${tool('LAUNCH')}\n${tool('RUN')}`,
    );
    write('src/web/index.ts', entry("['list_workflows', 'launch_workflow', 'workflow_run']"));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
    write('src/web/index.ts', entry("['list_workflows']"));
    const result = webPluginToolRenderers.check?.(file, root);
    expect(result).toContain('launch_workflow (src/tools/tools.ts)');
    expect(result).toContain('workflow_run (src/tools/tools.ts)');
  });

  it('reports an unclaimed tool with the file that registers it', () => {
    const file = manifest();
    write('src/tools/tool.ts', `${tool("'read'")}\n${tool("'write'")}`);
    write('src/web/index.ts', entry("['read']"));
    const result = webPluginToolRenderers.check?.(file, root);
    expect(result).toContain('write (src/tools/tool.ts)');
    expect(result).not.toContain('read (');
    expect(result).toContain('toolRenderers');
  });

  it('requires a matches renderer for a name computed at runtime', () => {
    const file = manifest();
    write('src/tools/tool.ts', tool('tool.piName'));
    write('src/web/index.ts', entry('[]'));
    expect(webPluginToolRenderers.check?.(file, root)).toContain('computed at runtime');
    write('src/web/index.ts', entry('[]', 'matches: () => true, '));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('skips a name imported from another package, and lists it only beside a real miss', () => {
    const file = manifest();
    write(
      'src/tools/tool.ts',
      `import { NARRATE_TOOL_NAME } from '@agimon-ai/doompi-voice/voice-tools';\n${tool('NARRATE_TOOL_NAME')}`,
    );
    write('src/web/index.ts', entry("['narrate']"));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
    write('src/tools/other.ts', tool("'other'"));
    const result = webPluginToolRenderers.check?.(file, root);
    expect(result).toContain('other (src/tools/other.ts)');
    expect(result).toContain('Not checked (name imported from a package): NARRATE_TOOL_NAME');
  });

  it('honours the ignore marker beside a definition', () => {
    const file = manifest();
    write(
      'src/tools/child.ts',
      `// web-plugin-tool-renderers: ignore structured_output (child process only)\n${tool("'structured_output'")}`,
    );
    write('src/web/index.ts', entry('[]'));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('ignores test files and fixtures under src', () => {
    const file = manifest();
    write('src/tools/tool.test.ts', tool("'ghost'"));
    write('src/fixtures/tool.ts', tool("'ghost'"));
    write('src/web/index.ts', entry('[]'));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  it('asks for a web plugin when tools are registered and none is declared', () => {
    const file = manifest(false);
    write('src/tools/tool.ts', tool("'read'"));
    expect(webPluginToolRenderers.check?.(file, root)).toContain('scaffold-doom-web-plugin');
  });

  it('reads a contribution array kept in a sibling web module', () => {
    const file = manifest();
    write('src/tools/tool.ts', `${tool("'subagent'")}\n${tool("'intercom'")}`);
    write(
      'src/web/toolRenderers.ts',
      "export const teamToolRenderers = [{ tools: ['subagent'], message: A }, { tools: ['intercom'], message: B }];",
    );
    write(
      'src/web/index.ts',
      `import { defineWebPlugin } from '${CONTRACTS}';\nimport { teamToolRenderers } from './toolRenderers.ts';\nexport const webPlugin = defineWebPlugin({ id: 'demo', toolRenderers: teamToolRenderers });`,
    );
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();
  });

  // The renderer scan walks the package's web root. If it resolved only the
  // pre-migration web/, a migrated package would report every tool as missing
  // a renderer, so the src/web layout is pinned here too.
  it('finds renderers in src/web and still reports a tool none of them claims', () => {
    const file = write(
      'package.json',
      JSON.stringify({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/exports/webClient.ts' } }),
    );
    write('src/tools/tool.ts', tool("'read'"));
    write('src/web/index.ts', entry("['read']"));
    expect(webPluginToolRenderers.check?.(file, root)).toBeNull();

    write('src/tools/tool.ts', `${tool("'read'")}\n${tool("'write'")}`);
    expect(webPluginToolRenderers.check?.(file, root)).toContain('write');
  });
});

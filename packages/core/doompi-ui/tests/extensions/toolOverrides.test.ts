import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
  type WriteToolInput,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinToolUi } from '../../src/adapters/pi/toolOverrides.ts';

const CWD = '/repo/project';
const EXPECTED_NAMES = ['read', 'edit', 'write', 'grep', 'find', 'ls'];

function plainTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    fg: (_color: string, text: string) => text,
    bold: identity,
    inverse: identity,
    dim: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  } as unknown as Theme;
}

function captureTools(cwd: string, shouldRegister?: (tool: string) => boolean): ToolDefinition[] {
  const registered: ToolDefinition[] = [];
  const pi = {
    registerTool: vi.fn((definition: ToolDefinition) => {
      registered.push(definition);
    }),
  } as unknown as ExtensionAPI;
  registerBuiltinToolUi(pi, cwd, shouldRegister);
  return registered;
}

describe('registerBuiltinToolUi', () => {
  it('preserves native definitions while overriding only non-bash rendering', () => {
    const registered = captureTools(CWD);

    expect(registered.map((tool) => tool.name)).toEqual(EXPECTED_NAMES);
    expect(registered.some((tool) => tool.name === 'bash')).toBe(false);

    const native = [
      createReadToolDefinition(CWD),
      createEditToolDefinition(CWD),
      createWriteToolDefinition(CWD),
      createGrepToolDefinition(CWD),
      createFindToolDefinition(CWD),
      createLsToolDefinition(CWD),
    ];
    for (const [index, tool] of registered.entries()) {
      const nativeTool = native[index];
      expect(tool.parameters).toBe(nativeTool?.parameters);
      expect(tool.description).toBe(nativeTool?.description);
      expect(tool.promptSnippet).toBe(nativeTool?.promptSnippet);
      expect(tool.promptGuidelines).toEqual(nativeTool?.promptGuidelines);
      expect(tool.execute).toEqual(expect.any(Function));
      expect(tool.renderShell).toBe('self');
      expect(tool.renderCall).toEqual(expect.any(Function));
      expect(tool.renderResult).toEqual(expect.any(Function));
    }
  });

  it('skips names owned by another standalone extension', () => {
    const registered = captureTools(CWD, (tool) => !['read', 'grep', 'edit'].includes(tool));

    expect(registered.map((tool) => tool.name)).toEqual(['write', 'find', 'ls']);
  });

  it('derives Write argument streaming state without marking restored results live', () => {
    const write = captureTools(CWD).find((tool) => tool.name === 'write') as ReturnType<
      typeof createWriteToolDefinition
    >;
    const args: WriteToolInput = {
      path: 'out.txt',
      content: Array.from({ length: 12 }, (_, index) => `line-${index.toString().padStart(2, '0')}`).join('\n'),
    };
    const context: Parameters<NonNullable<typeof write.renderCall>>[2] = {
      args,
      toolCallId: 'call-1',
      invalidate: vi.fn(),
      lastComponent: undefined,
      state: {},
      cwd: CWD,
      executionStarted: false,
      argsComplete: false,
      isPartial: true,
      expanded: false,
      showImages: true,
      isError: false,
    };

    const output = write.renderCall?.(args, plainTheme(), context).render(120).join('\n');
    expect(output).not.toContain('line-00');
    expect(output).toContain('line-11');
    expect(output).toContain('live tail');

    const restoredOutput = write
      .renderCall?.(args, plainTheme(), { ...context, isPartial: false })
      .render(120)
      .join('\n');
    expect(restoredOutput).toContain('line-00');
    expect(restoredOutput).not.toContain('live tail');
  });

  it('retains Pi native execution instead of substituting a UI-owned implementation', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-ui-tools-'));
    fs.writeFileSync(path.join(cwd, 'sample.txt'), 'native read output');
    const read = captureTools(cwd).find((tool) => tool.name === 'read') as ReturnType<typeof createReadToolDefinition>;

    const result = await read.execute('call-1', { path: 'sample.txt' }, undefined, undefined, {
      cwd,
    } as ExtensionContext);

    expect(result.content).toEqual([{ type: 'text', text: 'native read output' }]);
  });
});

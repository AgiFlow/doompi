import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createStyleSystemPiRoot,
  styleSystemSkillDirectory,
} from '../../src/extensions/workspaces/sessions/(backend)/_lib/piRoot';

describe('style-system Pi steering', () => {
  it('adds one targeted reminder after a successful UI source edit', async () => {
    const { value } = createStyleSystemPiRoot();
    const event = {
      type: 'tool_result' as const,
      toolCallId: 'edit-1',
      toolName: 'edit' as const,
      input: { path: 'src/Button.tsx' },
      content: [{ type: 'text' as const, text: 'updated' }],
      isError: false,
      details: undefined,
    };

    const first = await value.toolResult(event, { cwd: '/workspace' } as never);
    const second = await value.toolResult({ ...event, toolCallId: 'edit-2' }, { cwd: '/workspace' } as never);
    const outside = await value.toolResult({ ...event, toolCallId: 'edit-3', input: { path: '../outside.tsx' } }, {
      cwd: '/workspace',
    } as never);

    expect(first?.content).toEqual([
      { type: 'text', text: 'updated' },
      {
        type: 'text',
        text: 'Design source changed. Use the design skill and CLI to check existing components and tokens; run the readiness check before requesting approval.',
      },
    ]);
    expect(second).toBeUndefined();
    expect(outside).toBeUndefined();
  });

  it('locates the package-owned portable skill directory', () => {
    expect(path.basename(styleSystemSkillDirectory())).toBe('skills');
  });
});

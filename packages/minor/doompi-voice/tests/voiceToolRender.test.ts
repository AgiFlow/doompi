import { VOICE_DESCRIBE_TOOL_NAME, VOICE_USE_TOOL_NAME } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  renderNarrationToolCall,
  renderNarrationToolResult,
  renderVoiceToolCall,
  renderVoiceToolResult,
} from '../src/adapters/pi/voiceToolRender.ts';

function plainTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    bold: identity,
    fg: (_color: string, text: string) => text,
    inverse: identity,
  } as unknown as Theme;
}

function rendered(component: { render(width: number): string[] }, width = 100): string {
  const lines = component.render(width);
  expect(lines.every((line) => line.length <= width)).toBe(true);
  return lines.join('\n');
}

const tools = [
  {
    source: '@agimon-ai/doompi-plan',
    id: 'plan-activate',
    name: 'activate_plan',
    label: 'Activate Plan',
    description: 'Activate or switch the serialized planning mode.',
    order: 10,
    inputSchema: {
      type: 'object',
      properties: { flavor: { enum: ['normal', 'debug', 'fable'] }, optional: { type: 'boolean' } },
      required: ['flavor'],
    },
    enabled: true,
  },
  {
    source: '@agimon-ai/doompi',
    id: 'domains-list',
    name: 'list_domains',
    label: 'List Domains',
    description: 'List active, effective, and available Doom domains.',
    order: 20,
    inputSchema: { type: 'object', properties: {} },
    enabled: false,
  },
];

describe('standalone narration tool rendering', () => {
  it('renders a compact sanitized utterance preview', () => {
    const call = rendered(
      renderNarrationToolCall({ text: `Opening\nupdate ${'detail '.repeat(20)}` }, plainTheme()),
      100,
    );

    expect(call).toContain(' VOICE   narrate Opening update');
    expect(call).toContain('…');
    expect(call).not.toContain('\n');
  });

  it.each([
    ['playing', '◐ Narration playing'],
    ['completed', '✓ Narration completed'],
    ['interrupted', '⊘ Narration interrupted'],
    ['superseded', '○ Narration superseded'],
    ['failed', '✗ Narration failed'],
  ])('renders the %s outcome', (outcome, expected) => {
    const result = rendered(
      renderNarrationToolResult(
        {},
        { details: { outcome } },
        { expanded: false, isPartial: outcome === 'playing' },
        plainTheme(),
      ),
    );
    expect(result).toContain(expected);
  });

  it('renders structured tool rejection errors without exposing the utterance', () => {
    const result = rendered(
      renderNarrationToolResult(
        { text: 'Private wording.' },
        {
          details: {
            outcome: 'failed',
            error: { code: 'VOICE_TOOL_STALE_SESSION', message: 'The Voice session changed.', retryable: true },
          },
        },
        { expanded: false, isError: true },
        plainTheme(),
      ),
    );
    expect(result).toContain('✗ The Voice session changed. · retryable');
    expect(result).not.toContain('Private wording.');
  });
});

describe('voice façade tool call rendering', () => {
  it('renders compact discovery calls without raw parameters', () => {
    const one = rendered(renderVoiceToolCall(VOICE_DESCRIBE_TOOL_NAME, { names: ['list_domains'] }, plainTheme()));
    expect(one).toContain(' VOICE  ☰ discover list_domains');

    const many = rendered(
      renderVoiceToolCall(VOICE_DESCRIBE_TOOL_NAME, { names: ['list_domains', 'switch_domains'] }, plainTheme()),
    );
    expect(many).toContain('2 capabilities');
    expect(many).not.toContain('switch_domains');
  });

  it('renders single and batched executions without tokens or inputs', () => {
    const single = rendered(
      renderVoiceToolCall(
        VOICE_USE_TOOL_NAME,
        {
          catalogToken: 'private-token',
          calls: [{ name: 'switch_domains', input: { domains: ['blend'] } }],
        },
        plainTheme(),
      ),
    );
    expect(single).toContain(' VOICE  ▶ run switch_domains');
    expect(single).not.toContain('private-token');
    expect(single).not.toContain('blend');

    const batch = rendered(
      renderVoiceToolCall(
        VOICE_USE_TOOL_NAME,
        {
          calls: [
            { name: 'a', input: {} },
            { name: 'b', input: {} },
          ],
        },
        plainTheme(),
      ),
    );
    expect(batch).toContain('2 capabilities');
  });
});

describe('voice façade tool result rendering', () => {
  it('renders a capability catalog instead of the dynamic prompt description', () => {
    const result = rendered(
      renderVoiceToolResult(
        VOICE_DESCRIBE_TOOL_NAME,
        {},
        {
          details: {
            hostGeneration: 'private-host',
            catalogToken: 'private-token',
            catalogRevision: 5,
            tools,
            conflicts: [],
            unknownNames: [],
          },
          content: [{ type: 'text', text: 'raw dynamic description that must not render' }],
        },
        { expanded: false },
        plainTheme(),
      ),
    );

    expect(result).toContain('2 voice capabilities · catalog rev 5');
    expect(result).toContain('● Activate Plan · activate_plan');
    expect(result).toContain('○ List Domains · list_domains · disabled');
    expect(result).not.toContain('raw dynamic description');
    expect(result).not.toContain('private-token');
    expect(result).not.toContain('private-host');
  });

  it('renders descriptions, input shapes, conflicts, and unknown names when expanded', () => {
    const result = rendered(
      renderVoiceToolResult(
        VOICE_DESCRIBE_TOOL_NAME,
        {},
        {
          details: {
            catalogRevision: 6,
            tools,
            conflicts: [{ name: 'duplicate', message: 'Two owners claim this name.', claims: [] }],
            unknownNames: ['missing'],
          },
        },
        { expanded: true },
        plainTheme(),
      ),
      120,
    );

    expect(result).toContain('Activate or switch the serialized planning mode.');
    expect(result).toContain('input  flavor: normal | debug | fable, optional?: boolean');
    expect(result).toContain('! duplicate · Two owners claim this name.');
    expect(result).toContain('? Unknown: missing');
  });

  it('renders rejected batches with actionable preflight errors', () => {
    const result = rendered(
      renderVoiceToolResult(
        VOICE_USE_TOOL_NAME,
        {},
        {
          details: {
            status: 'rejected',
            catalogToken: 'private-token',
            results: [
              {
                index: 0,
                name: 'switch_domains',
                status: 'preflight_failed',
                error: { code: 'VOICE_TOOL_INVALID_INPUT', message: 'domains must be an array.' },
              },
            ],
            errors: [{ code: 'VOICE_TOOL_INVALID_INPUT', message: 'domains must be an array.' }],
          },
        },
        { expanded: false },
        plainTheme(),
      ),
    );

    expect(result).toContain('✗ Voice batch rejected · 1 call');
    expect(result).toContain('✗ switch_domains · preflight failed · domains must be an array.');
    expect(result).not.toContain('private-token');
    expect(result.match(/domains must be an array\./gu)).toHaveLength(1);
  });

  it('formats completed capability values as readable fields', () => {
    const result = rendered(
      renderVoiceToolResult(
        VOICE_USE_TOOL_NAME,
        {},
        {
          details: {
            status: 'completed',
            catalogToken: 'private-token',
            results: [
              {
                index: 0,
                name: 'list_domains',
                status: 'completed',
                result: { active: ['blend'], effective: ['blend'], available: ['blend', 'plan'] },
              },
              {
                index: 1,
                name: 'activate_plan',
                status: 'completed',
                result: { active: true, flavor: 'debug', changed: false },
              },
            ],
          },
        },
        { expanded: false },
        plainTheme(),
      ),
    );

    expect(result).toContain('✓ Voice batch completed · 2 calls');
    expect(result).toContain('✓ list_domains · completed');
    expect(result).toContain('active blend');
    expect(result).toContain('available blend, plan');
    expect(result).toContain('flavor debug');
  });

  it('bounds large catalogs and summarizes varied JSON schemas', () => {
    const schemaTools = Array.from({ length: 8 }, (_, index) => ({
      ...tools[0],
      id: `tool-${index}`,
      name: `tool_${index}`,
      label: `Tool ${index}`,
      inputSchema: {
        type: 'object',
        properties: {
          literal: { const: true },
          nullable: { type: ['string', 'null'] },
          choice: { anyOf: [{ type: 'number' }, { const: 'auto' }] },
          mystery: 42,
        },
      },
    }));
    const collapsed = rendered(
      renderVoiceToolResult(
        VOICE_DESCRIBE_TOOL_NAME,
        {},
        { details: { tools: schemaTools, conflicts: [], unknownNames: [] } },
        { expanded: false },
        plainTheme(),
      ),
    );
    expect(collapsed).toContain('… 2 more · ctrl+o');
    expect(collapsed).not.toContain('Tool 7');

    const expanded = rendered(
      renderVoiceToolResult(
        VOICE_DESCRIBE_TOOL_NAME,
        {},
        { details: { tools: [schemaTools[0]], conflicts: [{}], unknownNames: [] } },
        { expanded: true },
        plainTheme(),
      ),
      140,
    );
    expect(expanded).toContain('literal?: true');
    expect(expanded).toContain('nullable?: string | null');
    expect(expanded).toContain('choice?: number | auto');
    expect(expanded).toContain('mystery?: value');
    expect(expanded).toContain('! capability · Conflicting registrations.');
  });

  it('bounds mixed batch outcomes and renders distinct global errors and scalar results', () => {
    const statuses = ['cancelled', 'stopped', 'not_executed', 'failed', 'completed'];
    const results = Array.from({ length: 10 }, (_, index) => ({
      index,
      name: `capability_${index}`,
      status: statuses[index % statuses.length],
      result:
        index === 4 ? [null, true, 3, 'ready'] : index === 9 ? { nested: { hidden: true }, empty: [] } : undefined,
    }));
    const collapsed = rendered(
      renderVoiceToolResult(
        VOICE_USE_TOOL_NAME,
        {},
        {
          details: {
            status: 'stopped',
            results,
            errors: [{ code: 'VOICE_TOOL_BATCH_STOPPED', message: 'Reload queued.' }],
          },
        },
        { expanded: false },
        plainTheme(),
      ),
    );
    expect(collapsed).toContain('■ Voice batch stopped · 10 calls');
    expect(collapsed).toContain('⊘ capability_0 · cancelled');
    expect(collapsed).toContain('■ capability_1 · stopped');
    expect(collapsed).toContain('○ capability_2 · not executed');
    expect(collapsed).toContain('null, true, 3, ready');
    expect(collapsed).toContain('… 2 more · ctrl+o');
    expect(collapsed).toContain('✗ Reload queued.');

    const expanded = rendered(
      renderVoiceToolResult(
        VOICE_USE_TOOL_NAME,
        {},
        { details: { status: 'completed', results: [results[9]], errors: [] } },
        { expanded: true },
        plainTheme(),
      ),
    );
    expect(expanded).toContain('empty none');
    expect(expanded).not.toContain('hidden');
  });

  it('renders façade errors, empty catalogs, and lifecycle fallbacks cleanly', () => {
    const error = rendered(
      renderVoiceToolResult(
        VOICE_USE_TOOL_NAME,
        {},
        {
          details: {
            error: {
              code: 'VOICE_TOOL_HOST_UNAVAILABLE',
              message: 'Autonomous voice is unavailable.',
              retryable: true,
            },
          },
        },
        { expanded: false },
        plainTheme(),
      ),
    );
    expect(error).toContain('✗ Autonomous voice is unavailable. · retryable');

    const empty = rendered(
      renderVoiceToolResult(
        VOICE_DESCRIBE_TOOL_NAME,
        {},
        { details: { catalogRevision: 0, tools: [], conflicts: [], unknownNames: [] } },
        { expanded: false },
        plainTheme(),
      ),
    );
    expect(empty).toContain('0 voice capabilities');
    expect(empty).toContain('No voice capabilities are currently registered.');

    expect(
      rendered(renderVoiceToolResult(VOICE_USE_TOOL_NAME, {}, {}, { expanded: false, isPartial: true }, plainTheme())),
    ).toContain('◐ Working…');
    expect(
      rendered(
        renderVoiceToolResult(
          VOICE_USE_TOOL_NAME,
          {},
          { isError: true, content: [{ type: 'text', text: 'bad\nrequest' }] },
          { expanded: false, isError: true },
          plainTheme(),
        ),
      ),
    ).toContain('✗ bad request');
    expect(
      rendered(
        renderVoiceToolResult(
          VOICE_USE_TOOL_NAME,
          {},
          { details: { error: { code: 'VOICE_TOOL_EXECUTION_FAILED' } } },
          { expanded: false },
          plainTheme(),
        ),
      ),
    ).toContain('✗ Voice capability failed.');
  });
});

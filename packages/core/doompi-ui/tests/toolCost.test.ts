import { describe, expect, it } from 'vitest';
import { type ToolEntry, type ToolSource, tokensForSource, tokensForTool } from '../src/exports/toolInventory.ts';

// One token per character keeps the arithmetic checkable by hand; the real
// tokenizer is injected by the caller and is not this module's concern.
const countChars = (text: string): number => text.length;

function entry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return { name: 'read', description: 'Reads a file', active: true, ...overrides };
}

describe('tokensForTool', () => {
  it('prices the tool-list payload from name, description, and parameters', () => {
    const tool = entry({ parameters: { type: 'object' } });
    const expected = JSON.stringify({
      name: 'read',
      description: 'Reads a file',
      parameters: { type: 'object' },
    }).length;

    expect(tokensForTool(tool, countChars)).toEqual({
      schemaTokens: expected,
      promptTokens: 0,
      totalTokens: expected,
    });
  });

  // The trap this function exists to avoid. Pi takes `toolSnippets` and
  // `promptGuidelines` as system-prompt inputs, separately from the tool list,
  // so a schema-only estimate silently undercounts any tool carrying prose.
  it('counts the system-prompt payload that never appears in the schema', () => {
    const bare = tokensForTool(entry(), countChars);
    const chatty = tokensForTool(entry({ promptSnippet: 'abc', promptGuidelines: ['de', 'f'] }), countChars);

    expect(chatty.schemaTokens).toBe(bare.schemaTokens);
    // 'abc\nde\nf' is eight characters, joined with one newline per bullet.
    expect(chatty.promptTokens).toBe(8);
    expect(chatty.totalTokens).toBe(bare.schemaTokens + 8);
  });

  it('charges nothing for prose a tool does not carry', () => {
    expect(tokensForTool(entry({ promptGuidelines: [] }), countChars).promptTokens).toBe(0);
  });

  it('omits absent fields rather than pricing the word undefined', () => {
    const nameOnly = tokensForTool({ name: 'x', active: true }, countChars);

    expect(nameOnly.schemaTokens).toBe(JSON.stringify({ name: 'x' }).length);
  });
});

describe('tokensForSource', () => {
  it('prices every tool and sums the source', () => {
    const source: ToolSource = {
      key: 'core',
      label: 'pi · core',
      kind: 'core',
      tools: [entry({ name: 'read' }), entry({ name: 'bash', promptSnippet: 'runs' })],
    };
    const { tools, totalTokens } = tokensForSource(source, countChars);

    expect([...tools.keys()]).toEqual(['read', 'bash']);
    expect(tools.get('bash')?.promptTokens).toBe(4);
    expect(totalTokens).toBe((tools.get('read')?.totalTokens ?? 0) + (tools.get('bash')?.totalTokens ?? 0));
  });

  // An inactive tool still occupies the composition, and the figure is about
  // what the composition costs rather than what the model may call.
  it('prices an inactive tool too', () => {
    const source: ToolSource = {
      key: 'core',
      label: 'pi · core',
      kind: 'core',
      tools: [entry({ name: 'read', active: false })],
    };

    expect(tokensForSource(source, countChars).totalTokens).toBeGreaterThan(0);
  });
});

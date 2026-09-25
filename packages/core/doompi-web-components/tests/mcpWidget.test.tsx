import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { McpToolFields, McpToolFrame, McpToolOutput } from '../src/components/McpToolWidget';

describe('MCP widget presentation primitives', () => {
  it.each([
    ['connecting', 'Connecting to host...'],
    ['preparing', 'Preparing tool...'],
    ['running', 'Running tool...'],
    ['result', 'Result received'],
    ['cancelled', 'Tool cancelled'],
    ['error', 'Tool failed'],
  ] as const)('renders the %s lifecycle without claiming background work has completed', (phase, status) => {
    expect(renderToStaticMarkup(<McpToolFrame title="Tool" phase={phase} result={null} />)).toContain(status);
  });

  it('escapes and bounds explicitly selected scalar fields, never serializing arbitrary nested arguments', () => {
    const html = renderToStaticMarkup(
      <McpToolFields
        fields={[
          ['Path', '<img src=x>'],
          ['Large', 'x'.repeat(600)],
          ['Boolean', true],
          ['Number', 0],
          ['Array', ['a', 'b']],
          ['Nested', { password: 'private' }],
          ['Invalid', Infinity],
          ['Empty', ''],
          ['Unknown', undefined],
        ]}
      />,
    );
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('x'.repeat(500) + '...');
    expect(html).not.toContain('x'.repeat(501));
    expect(html).not.toContain('private');
    expect(html).not.toContain('Infinity');
    expect(html).toContain('a, b');
    expect(renderToStaticMarkup(<McpToolFields fields={[]} />)).toBe('');
  });

  it('preserves native output as bounded text with an accessible expansion control', () => {
    const html = renderToStaticMarkup(
      <McpToolOutput result={{ content: [{ type: 'text', text: '<script>bad()</script>' + 'a'.repeat(9000) }] }} />,
    );
    expect(html).toContain('<details open="">');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Preview truncated');
    expect(html).toContain('tabindex="0"');
    expect(renderToStaticMarkup(<McpToolOutput result={null} />)).toBe('');
  });

  it('supports structured-only, non-text and empty results without fetching or embedding resources', () => {
    const structured = renderToStaticMarkup(
      <McpToolOutput result={{ content: [], structuredContent: { status: 'in_progress' } }} />,
    );
    expect(structured).toContain('in_progress');
    const image = renderToStaticMarkup(
      <McpToolOutput result={{ content: [{ type: 'image', data: 'bad', mimeType: 'image/png' }] }} />,
    );
    expect(image).toContain('Non-text result returned to the agent.');
    expect(image).toContain('1 non-text');
    expect(image).not.toContain('<img');
    expect(renderToStaticMarkup(<McpToolOutput result={{ content: [] }} />)).toContain('No text output.');
  });

  it('renders execution errors without adding retry controls', () => {
    const html = renderToStaticMarkup(
      <McpToolFrame title="Write" phase="result" result={{ content: [], isError: true }} error="Permission denied" />,
    );
    expect(html).toContain('Permission denied');
    expect(html).not.toContain('<button');
  });
});

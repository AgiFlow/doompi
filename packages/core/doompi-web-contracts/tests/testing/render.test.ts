import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderPlugin } from '../../src/services/testing/render.ts';
import { slotPropsFixture, toolMessagePropsFixture } from '../../src/services/testing/slotProps.ts';
import type { ToolMessageRenderProps, WebPluginSlotProps } from '../../src/types/webPlugin.ts';

function Panel({ sessionId, statuses }: WebPluginSlotProps) {
  return createElement('div', { className: 'panel' }, `session ${sessionId ?? 'none'}: ${statuses.mood ?? 'quiet'}`);
}

function Crashing(): never {
  throw new Error('this component reads a field the host never sends');
}

function ToolCard({ toolName, running, output }: ToolMessageRenderProps) {
  return createElement(
    'section',
    null,
    `${toolName} ${running ? 'running' : 'done'}`,
    createElement('pre', null, output),
  );
}

describe('rendering a plugin component', () => {
  it('renders it with the props the host sends and reads the page, not the markup', () => {
    const { props } = slotPropsFixture({ sessionId: 's1', statuses: { mood: 'busy' } });

    const rendered = renderPlugin(Panel, props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('class="panel"');
    // `includes` strips the tags, so an assertion survives a wrapper element
    // being added around the text.
    expect(rendered.includes('session s1: busy')).toBe(true);
  });

  it('hands back what a component threw, rather than failing the caller', () => {
    const { props } = slotPropsFixture();

    const rendered = renderPlugin(Crashing, props);

    // The host catches a throwing item and keeps the page up, so proving that
    // path needs the error as a value.
    expect(rendered.error?.message).toContain('reads a field the host never sends');
    expect(rendered.html).toBe('');
    expect(rendered.includes('anything')).toBe(false);
  });

  it('renders a tool item in each state the host puts it in', () => {
    const running = toolMessagePropsFixture({ toolName: 'bash', running: true, output: 'ls' });
    const finished = toolMessagePropsFixture({ toolName: 'bash', output: 'a.ts' });

    expect(renderPlugin(ToolCard, running.props).includes('bash running')).toBe(true);
    expect(renderPlugin(ToolCard, finished.props).includes('bash done')).toBe(true);
    expect(renderPlugin(ToolCard, finished.props).includes('a.ts')).toBe(true);
  });
});

import { renderPlugin, toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it } from 'vitest';
import { PlanToolMessage } from '../../web/PlanToolMessage.tsx';
import { webPlugin } from '../../web/index.ts';

/**
 * The cockpit half of this package, rendered.
 *
 * `planToolRender` is already covered as a pure function, but nothing has ever
 * mounted the component that draws its output, so a wrong prop name or a lookup
 * on a result the host sends as null would only surface in a browser.
 */

function render(options: Parameters<typeof toolMessagePropsFixture>[0]) {
  return renderPlugin(PlanToolMessage, toolMessagePropsFixture(options).props);
}

describe('the plan tool timeline item', () => {
  it('draws a completed write_plan with the path it wrote', () => {
    const rendered = render({
      toolName: 'write_plan',
      args: { path: 'docs/plan.md' },
      result: { content: [], details: { written: true, path: 'docs/plan.md' } },
    });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="tool-call-write_plan"');
    expect(rendered.includes('docs/plan.md')).toBe(true);
  });

  it('draws a call whose result the host has not sent yet', () => {
    // The host sends result: null for every tool before its first output, and a
    // renderer that reads through it crashes on its own opening frame.
    const rendered = render({ toolName: 'write_plan', args: { path: 'docs/plan.md' }, running: true });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('tool-call-write_plan');
  });

  it('draws a failure without losing the header', () => {
    const rendered = render({
      toolName: 'complete_plan',
      args: {},
      isError: true,
      output: 'the plan was never written',
      result: { content: [{ type: 'text', text: 'the plan was never written' }], details: undefined },
    });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('tool-call-complete_plan');
  });

  it('draws every tool the plugin claims, on empty arguments', () => {
    // A renderer claims a list of names and the host routes all of them to it,
    // so any one that throws takes out a timeline row.
    const claimed = webPlugin.toolRenderers?.flatMap(({ tools }) => tools) ?? [];

    expect(claimed.length).toBeGreaterThan(0);
    for (const toolName of claimed) {
      const rendered = render({ toolName });
      expect(rendered.error, toolName).toBeUndefined();
      expect(rendered.html, toolName).toContain(`tool-call-${toolName}`);
    }
  });
});

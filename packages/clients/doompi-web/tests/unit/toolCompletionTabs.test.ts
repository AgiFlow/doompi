import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateWebPluginSession, installSessionWebPlugins, resetWebPlugins } from '../../src/web/lib/pluginRegistry';
import { createToolCompletionTabs } from '../../src/web/lib/toolCompletionTabs';

function plugin() {
  return defineWebPlugin({
    id: 'completion-tabs',
    toolRenderers: [
      {
        tools: ['open_document'],
        message: () => null,
        completionTab: ({ result }) => {
          const details = result.details as { path?: unknown } | null;
          return typeof details?.path === 'string'
            ? { id: `document:${details.path}`, label: details.path, panel: () => null }
            : undefined;
        },
      },
    ],
  });
}

const start = {
  type: 'tool_execution_start',
  toolCallId: 'call-1',
  toolName: 'open_document',
  args: { path: 'docs/report.md' },
};
const end = {
  type: 'tool_execution_end',
  toolCallId: 'call-1',
  result: { content: [], details: { path: 'docs/report.md' } },
};

afterEach(() => resetWebPlugins());

describe('live tool completion tabs', () => {
  it('buffers completion until session plugins initialize and deduplicates repeated end frames', () => {
    const open = vi.fn();
    const tabs = createToolCompletionTabs(open);
    activateWebPluginSession('origin');

    tabs.apply('origin', start);
    tabs.apply('origin', end);
    tabs.apply('origin', end);
    expect(open).not.toHaveBeenCalled();

    installSessionWebPlugins('origin', [plugin()]);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('origin', expect.objectContaining({ id: 'document:docs/report.md' }));

    tabs.apply('origin', end);
    expect(open).toHaveBeenCalledOnce();
    tabs.dispose();
  });

  it('ignores replay and failed completion, and opens against a background originating session', () => {
    const open = vi.fn();
    const tabs = createToolCompletionTabs(open);
    activateWebPluginSession('background');
    installSessionWebPlugins('background', [plugin()]);
    activateWebPluginSession('active');
    installSessionWebPlugins('active', []);

    tabs.apply('background', start, true);
    tabs.apply('background', end, true);
    tabs.apply('background', start);
    tabs.apply('background', { ...end, isError: true });
    expect(open).not.toHaveBeenCalled();

    tabs.apply('background', { ...start, toolCallId: 'call-2' });
    tabs.apply('background', { ...end, toolCallId: 'call-2' });
    expect(open).toHaveBeenCalledWith('background', expect.objectContaining({ id: 'document:docs/report.md' }));

    tabs.apply('background', { ...start, toolCallId: 'call-3' }, true);
    tabs.apply('background', { ...end, toolCallId: 'call-3' });
    expect(open).toHaveBeenCalledTimes(2);
    tabs.dispose();
  });
});

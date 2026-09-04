import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { defineSlot } from '../../src/services/define.ts';
import { renderPlugin } from '../../src/services/testing/render.ts';
import { slotPropsFixture, toolMessagePropsFixture } from '../../src/services/testing/slotProps.ts';
import type { WebPluginSlotProps } from '../../src/types/webPlugin.ts';

describe('the slot props a component receives', () => {
  it('records what a component did through every action it was handed', () => {
    const fixture = slotPropsFixture({ sessionId: 's1' });

    fixture.props.openTab('runners');
    fixture.props.openTab(null);
    fixture.props.appendComposerDraft('continue here');
    fixture.props.attachComposerContext({
      kind: 'work-item',
      source: 'agiflow',
      id: 'task-1',
      label: 'AGI-1',
      content: 'Fix auth.',
    });
    fixture.props.sendSessionFrame('s1', { type: 'prompt', text: 'go' });
    fixture.props.openTransientTab({ id: 'runner-log-7', label: 'Log', panel: () => null });
    fixture.props.closeTransientTab('runner-log-7');

    expect(fixture.actions).toEqual([
      { action: 'openTab', target: 'runners' },
      { action: 'openTab', target: null },
      { action: 'appendComposerDraft', target: 's1', text: 'continue here' },
      {
        action: 'attachComposerContext',
        target: 's1',
        context: { kind: 'work-item', source: 'agiflow', id: 'task-1', label: 'AGI-1', content: 'Fix auth.' },
      },
      { action: 'sendSessionFrame', target: 's1', frame: { type: 'prompt', text: 'go' } },
      { action: 'openTransientTab', target: 'runner-log-7' },
      { action: 'closeTransientTab', target: 'runner-log-7' },
    ]);
    expect(fixture.frames()).toEqual([{ type: 'prompt', text: 'go' }]);
  });

  it('returns installed context actions for the item under test', () => {
    const seen: string[] = [];
    const fixture = slotPropsFixture({
      contextActions: (item) => [{ id: 'team.launch', label: 'Launch Agent', run: () => seen.push(item.id) }],
    });
    const actions = fixture.props.contextActionsFor({
      kind: 'work-item',
      source: 'agiflow',
      id: 'task-1',
      label: 'AGI-1',
      content: 'Fix auth.',
    });

    expect(actions.map(({ id, label }) => [id, label])).toEqual([['team.launch', 'Launch Agent']]);
    actions[0]?.run();
    expect(seen).toEqual(['task-1']);
  });

  it('defaults to a focused session and no statuses, and takes an unfocused one', () => {
    expect(slotPropsFixture().props.sessionId).toBe('s1');
    expect(slotPropsFixture().props.statuses).toEqual({});
    // null is the state the host is in before anything is focused, and a
    // component that assumes a session crashes there.
    expect(slotPropsFixture({ sessionId: null }).props.sessionId).toBeNull();
  });

  it('answers a slot owner with the data fills a test declared, through its own handle', () => {
    const badges = defineSlot<{ label: string }>({
      slot: 'owner.badges',
      parse: (input) => (input as { label: string }) ?? null,
    });
    const fixture = slotPropsFixture({
      slotData: { 'owner.badges': [{ pluginId: 'filler', id: 'a', order: 1, data: { label: 'alpha' } }] },
    });

    const fills = fixture.props.slotData(badges);

    expect(fills.map(({ data }) => data.label)).toEqual(['alpha']);
    // A slot nobody filled reads empty rather than undefined: the owner renders
    // with zero fills, which is an ordinary state.
    expect(fixture.props.slotData(defineSlot({ slot: 'owner.other' }))).toEqual([]);
  });

  it('renders the component fills an owner places, and nothing for an unfilled slot', () => {
    const fixture = slotPropsFixture({
      slotContent: { 'owner.items': createElement('span', null, 'filled') },
    });

    function Owner({ renderSlot }: WebPluginSlotProps) {
      return createElement('div', null, renderSlot('owner.items'), renderSlot('owner.empty'));
    }

    expect(renderPlugin(Owner, fixture.props).includes('filled')).toBe(true);
  });

  it('renders a thread for the plugin that asks for one', () => {
    const fixture = slotPropsFixture({ thread: (threadId) => createElement('em', null, `thread ${threadId}`) });

    function Threaded({ renderThread }: WebPluginSlotProps) {
      return createElement('div', null, renderThread('run-3'));
    }

    expect(renderPlugin(Threaded, fixture.props).includes('thread run-3')).toBe(true);
    expect(slotPropsFixture().props.renderThread('run-3')).toBeNull();
  });
});

describe('the props a tool item receives', () => {
  it('describes a tool that has produced nothing yet', () => {
    const { props } = toolMessagePropsFixture({ toolName: 'bash' });

    // Before any output the host sends a null result, and a plugin that reads
    // result.content without checking crashes on its own first frame.
    expect(props).toMatchObject({ toolCallId: 'call-1', toolName: 'bash', args: {}, result: null, output: '' });
    expect(props.running).toBe(false);
    expect(props.isError).toBe(false);
  });

  it('carries the call, its newest result, and the slot actions together', () => {
    const fixture = toolMessagePropsFixture({
      toolName: 'workflow_run',
      toolCallId: 'call-9',
      args: { action: 'status' },
      result: { content: [{ type: 'text', text: 'running' }], details: { runKey: 'blog-4' } },
      output: 'running',
      running: true,
      isError: false,
      statuses: { 'doom-workflow': 'blog-4' },
    });

    fixture.props.sendSessionFrame('s1', { type: 'prompt' });

    expect(fixture.props).toMatchObject({
      toolCallId: 'call-9',
      args: { action: 'status' },
      output: 'running',
      running: true,
      statuses: { 'doom-workflow': 'blog-4' },
    });
    expect(fixture.props.result?.details).toEqual({ runKey: 'blog-4' });
    expect(fixture.frames()).toHaveLength(1);
  });

  it('describes a tool that failed', () => {
    const { props } = toolMessagePropsFixture({
      toolName: 'bash',
      isError: true,
      output: 'command not found',
      result: { content: [], details: undefined },
    });

    expect(props.isError).toBe(true);
    expect(props.output).toBe('command not found');
  });
});

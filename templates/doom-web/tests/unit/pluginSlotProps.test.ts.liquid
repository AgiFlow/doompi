import {
  type ComposerCapture,
  defineSlot,
  defineWebPlugin,
  type TransientTab,
  type WebPluginContextItem,
  type WebPluginSlotProps,
} from '@agimon-ai/doompi-web-contracts';
import { createElement, isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installWebPlugins, resetWebPlugins } from '../../src/web/lib/pluginRegistry.ts';
import { pluginSlotProps } from '../../src/web/lib/pluginSlotProps.ts';
import { bindThreadRenderer, releaseThreadRenderer } from '../../src/web/lib/threadRenderer.ts';
import { bindTransport, releaseTransport } from '../../src/web/lib/transport.ts';
import {
  appendComposerDraft,
  composerStore,
  resetComposerStore,
  updateComposerState,
} from '../../src/web/stores/composerStore.ts';

function Panel(): null {
  return null;
}

function Nested(): null {
  return null;
}

const noTabs = { open: (): void => undefined, close: (): void => undefined };
const noAppend = (): void => undefined;
const noAttach = (): void => undefined;

afterEach(() => {
  resetWebPlugins();
  resetComposerStore();
  releaseThreadRenderer();
  releaseTransport();
});

describe('pluginSlotProps', () => {
  it("renders a slot's component fills with the same props and reads a data slot through its handle", () => {
    const badges = defineSlot<{ label: string }>({
      slot: 'owner.badges',
      parse(input) {
        const label = (input as { label?: unknown } | null)?.label;
        return typeof label === 'string' ? { label } : null;
      },
    });
    installWebPlugins([
      defineWebPlugin({ id: 'owner', slots: [defineSlot({ slot: 'owner.items' }), badges] }),
      defineWebPlugin({
        id: 'filler',
        fills: [
          { slot: 'owner.items', id: 'two', order: 2, component: Nested },
          { slot: 'owner.items', id: 'one', order: 1, component: Panel },
          { slot: 'owner.badges', id: 'b', data: { label: 'beta' } },
          { slot: 'owner.badges', id: 'a', order: 1, data: { label: 'alpha' } },
        ],
      }),
    ]);
    const opened: Array<string | null> = [];
    const props = pluginSlotProps('s1', (tabId) => opened.push(tabId), {}, noTabs, noAppend, noAttach);

    const rendered = props.renderSlot('owner.items') as ReactElement<WebPluginSlotProps>[];
    expect(rendered.map((element) => [isValidElement(element), element.type, element.key])).toEqual([
      [true, Panel, 'filler:one'],
      [true, Nested, 'filler:two'],
    ]);
    // Every fill receives the owner's own props, so a fill can render its own slots.
    expect(rendered[0]?.props.sessionId).toBe('s1');
    expect(rendered[0]?.props.renderSlot).toBe(props.renderSlot);
    rendered[0]?.props.openTab('subagents');
    expect(opened).toEqual(['subagents']);
    expect(typeof props.sendSessionFrame).toBe('function');

    expect(props.slotData(badges)).toEqual([
      { pluginId: 'filler', id: 'a', order: 1, data: { label: 'alpha' } },
      { pluginId: 'filler', id: 'b', order: 1000, data: { label: 'beta' } },
    ]);
    // Component fills are not data, data fills are not components.
    expect(props.slotData(defineSlot({ slot: 'owner.items' }))).toEqual([]);
    expect(props.renderSlot('owner.badges')).toEqual([]);
    expect(props.renderSlot('nobody.home')).toEqual([]);
  });

  it('binds structured composer context and actions contributed by independent plugins', () => {
    const item: WebPluginContextItem = {
      kind: 'work-item',
      source: 'agiflow',
      id: 'task-1',
      label: 'AGI-1: Fix auth',
      content: 'Fix the repository authentication flow.',
    };
    const attached: WebPluginContextItem[] = [];
    const captures: ComposerCapture[] = [];
    const opened: TransientTab[] = [];
    const sent: object[] = [];
    bindTransport((frame) => sent.push(frame));
    installWebPlugins([
      defineWebPlugin({
        id: 'team',
        contextActions: [
          {
            id: 'launch',
            label: 'Launch Agent',
            kinds: ['work-item'],
            run: ({ item: received, openTransientTab }) =>
              openTransientTab({ id: `team-${received.id}`, label: received.label, panel: Panel }),
          },
        ],
      }),
      defineWebPlugin({
        id: 'unrelated',
        contextActions: [{ id: 'inspect', label: 'Inspect image', kinds: ['image'], run: () => undefined }],
      }),
    ]);
    const props = pluginSlotProps(
      's1',
      () => undefined,
      {},
      { open: (tab) => opened.push(tab), close: () => undefined },
      noAppend,
      (context) => attached.push(context),
      (capture) => captures.push(capture),
    );

    props.attachComposerContext(item);
    const capture: ComposerCapture = { data: 'iVBORw==', mimeType: 'image/png', context: item };
    props.attachComposerCapture(capture);
    const actions = props.contextActionsFor(item);
    expect(attached).toEqual([item]);
    expect(captures).toEqual([capture]);
    expect(sent).toEqual([]);
    expect(actions.map(({ id, label }) => [id, label])).toEqual([['team.launch', 'Launch Agent']]);
    actions[0]?.run();
    expect(opened.map((tab) => tab.id)).toEqual(['team-task-1']);
  });

  it('orders namespaced context actions and binds focused or detached session context', () => {
    const item: WebPluginContextItem = {
      kind: 'work-item',
      source: 'agiflow',
      id: 'task-2',
      label: 'AGI-2: Add tests',
      content: 'Add focused host coverage for plugin actions.',
    };
    const image: WebPluginContextItem = {
      kind: 'image',
      source: 'uploads',
      id: 'image-1',
      label: 'Screenshot',
      content: 'A screenshot attachment.',
    };
    const runs: Array<{ id: string; item: WebPluginContextItem; sessionId: string | null }> = [];

    installWebPlugins([
      defineWebPlugin({
        id: 'beta',
        contextActions: [
          {
            id: 'review',
            label: 'Review',
            order: 20,
            kinds: ['work-item'],
            run: ({ item: received, sessionId }) => runs.push({ id: 'beta.review', item: received, sessionId }),
          },
        ],
      }),
      defineWebPlugin({
        id: 'alpha',
        contextActions: [
          {
            id: 'start',
            label: 'Start',
            detail: 'Start with this work item',
            order: 10,
            kinds: ['work-item'],
            run: ({ item: received, sessionId }) => runs.push({ id: 'alpha.start', item: received, sessionId }),
          },
        ],
      }),
    ]);

    const focused = pluginSlotProps('focused-session', () => undefined, {}, noTabs, noAppend, noAttach);
    const focusedActions = focused.contextActionsFor(item);
    expect(focusedActions.map(({ id, label }) => [id, label])).toEqual([
      ['alpha.start', 'Start'],
      ['beta.review', 'Review'],
    ]);
    expect(focusedActions[0]?.detail).toBe('Start with this work item');
    expect(focused.contextActionsFor(image)).toEqual([]);

    focusedActions.forEach((action) => action.run());

    const detached = pluginSlotProps(null, () => undefined, {}, noTabs, noAppend, noAttach);
    detached.contextActionsFor(item).forEach((action) => action.run());

    expect(runs).toEqual([
      { id: 'alpha.start', item, sessionId: 'focused-session' },
      { id: 'beta.review', item, sessionId: 'focused-session' },
      { id: 'alpha.start', item, sessionId: null },
      { id: 'beta.review', item, sessionId: null },
    ]);
  });

  it('binds composer draft appends to the focused session', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'existing' }));
    updateComposerState('s2', (state) => ({ ...state, draft: 'other' }));

    const props = pluginSlotProps(
      's1',
      () => undefined,
      {},
      noTabs,
      (text) => appendComposerDraft('s1', text),
      noAttach,
    );
    props.appendComposerDraft(' transcript ');

    expect(composerStore.state.s1?.draft).toBe('existing transcript');
    expect(composerStore.state.s2?.draft).toBe('other');
    pluginSlotProps(
      null,
      () => undefined,
      {},
      noTabs,
      (text) => appendComposerDraft(null, text),
      noAttach,
    ).appendComposerDraft('detached');
    expect(Object.keys(composerStore.state)).toEqual(['s1', 's2']);
  });
});

describe('the statuses a plugin component receives', () => {
  it('hands every fill the session footer statuses, and the same object to a nested slot', () => {
    const seen: Array<Readonly<Record<string, string>>> = [];
    const Leaf = (props: WebPluginSlotProps): null => {
      seen.push(props.statuses);
      return null;
    };
    installWebPlugins([
      defineWebPlugin({ id: 'owner', slots: [defineSlot({ slot: 'owner.items' })] }),
      defineWebPlugin({ id: 'filler', fills: [{ slot: 'owner.items', id: 'one', component: Leaf }] }),
    ]);

    const statuses = { 'doom-voice': 'voice auto: listening' };
    const props = pluginSlotProps('s1', () => undefined, statuses, noTabs, noAppend, noAttach);
    expect(props.statuses).toBe(statuses);

    const rendered = props.renderSlot('owner.items') as ReactElement<WebPluginSlotProps>[];
    expect(rendered[0]?.props.statuses).toBe(statuses);
  });
});

describe('the runtime tabs and threads a plugin component may open', () => {
  it('hands transient tab actions to the host and renders a thread through the bound view', () => {
    const opened: TransientTab[] = [];
    const closed: string[] = [];
    const props = pluginSlotProps(
      's1',
      () => undefined,
      {},
      {
        open: (tab) => opened.push(tab),
        close: (tabId) => closed.push(tabId),
      },
      noAppend,
      noAttach,
    );
    const tab: TransientTab = { id: 'owner-thing-1', label: 'thing', panel: Panel };
    props.openTransientTab(tab);
    props.closeTransientTab('owner-thing-1');
    expect(opened).toEqual([tab]);
    expect(closed).toEqual(['owner-thing-1']);

    // Nothing is bound before the app mounts, and a thread needs a focused session.
    expect(props.renderThread('run-1')).toBeNull();
    bindThreadRenderer((sessionId, threadId) => createElement(Panel, { key: `${sessionId}/${threadId}` }));
    const rendered = props.renderThread('run-1') as ReactElement;
    expect(isValidElement(rendered)).toBe(true);
    expect(rendered.key).toBe('s1/run-1');
    expect(pluginSlotProps(null, () => undefined, {}, noTabs, noAppend, noAttach).renderThread('run-1')).toBeNull();
  });
});

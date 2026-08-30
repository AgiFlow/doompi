import type { ReactNode } from 'react';
import type {
  SlotDataFill,
  SlotDeclaration,
  ToolMessageRenderProps,
  ToolResultView,
  TransientTab,
  WebPluginSlotProps,
} from '../../types/webPlugin.ts';

/**
 * The props the cockpit hands a plugin's components, built for a test.
 *
 * A plugin component takes fifteen props and reads three of them. Written out
 * by hand in each test, the other twelve are noise that goes stale the moment
 * the contract grows a member; written as a cast, the component compiles
 * against props the host never sends. This builds all of them, records what the
 * component did with the actions, and lets a test override the two or three it
 * cares about.
 */

export interface RecordedSlotAction {
  action: 'appendComposerDraft' | 'openTab' | 'openTransientTab' | 'closeTransientTab' | 'sendSessionFrame';
  /** The tab id, the transient tab's id, or the target session of a frame or composer append. */
  target: string | null;
  /** The text passed to `appendComposerDraft`. */
  text?: string;
  /** The frame a component sent, for `sendSessionFrame`. */
  frame?: Record<string, unknown>;
}

export interface SlotPropsFixture {
  props: WebPluginSlotProps;
  /** Everything the component did through its props, in order. */
  readonly actions: readonly RecordedSlotAction[];
  /** Frames the component sent, which is what most assertions want. */
  frames(): readonly Record<string, unknown>[];
}

export interface SlotPropsOptions {
  sessionId?: string | null;
  statuses?: Readonly<Record<string, string>>;
  /** Component fills this slot owner should see; keyed by slot name. */
  slotContent?: Readonly<Record<string, ReactNode>>;
  /** Data fills this slot owner should read back, keyed by slot name. */
  slotData?: Readonly<Record<string, readonly SlotDataFill[]>>;
  /** What `renderThread` returns for a plugin that renders one. */
  thread?: (threadId: string) => ReactNode;
}

const DEFAULT_SESSION_ID = 's1';

export function slotPropsFixture(options: SlotPropsOptions = {}): SlotPropsFixture {
  const actions: RecordedSlotAction[] = [];
  const props: WebPluginSlotProps = {
    sessionId: options.sessionId === undefined ? DEFAULT_SESSION_ID : options.sessionId,
    statuses: options.statuses ?? {},
    openTab: (tabId) => {
      actions.push({ action: 'openTab', target: tabId });
    },
    openTransientTab: (tab: TransientTab) => {
      actions.push({ action: 'openTransientTab', target: tab.id });
    },
    closeTransientTab: (tabId: string) => {
      actions.push({ action: 'closeTransientTab', target: tabId });
    },
    appendComposerDraft: (text) => {
      actions.push({ action: 'appendComposerDraft', target: props.sessionId, text });
    },
    sendSessionFrame: (sessionId, frame) => {
      actions.push({ action: 'sendSessionFrame', target: sessionId, frame });
    },
    renderThread: (threadId) => options.thread?.(threadId) ?? null,
    renderSlot: (slot) => options.slotContent?.[slot] ?? null,
    // The host resolves fills by slot name and hands the owner its own typed
    // view, so a test declares them by name too.
    slotData: <Data>(slot: SlotDeclaration<Data>) =>
      (options.slotData?.[slot.slot] ?? []) as readonly SlotDataFill<Data>[],
  };

  return {
    props,
    actions,
    frames: () => actions.flatMap((entry) => (entry.frame ? [entry.frame] : [])),
  };
}

export interface ToolMessagePropsOptions extends SlotPropsOptions {
  toolCallId?: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** The newest result; null is what the host sends before any output. */
  result?: ToolResultView | null;
  /** The result's text blocks joined, as the host's own fallback item shows them. */
  output?: string;
  running?: boolean;
  isError?: boolean;
}

export interface ToolMessagePropsFixture extends Omit<SlotPropsFixture, 'props'> {
  props: ToolMessageRenderProps;
}

const DEFAULT_TOOL_CALL_ID = 'call-1';

/** The props a tool's timeline item receives, in any of its four states. */
export function toolMessagePropsFixture(options: ToolMessagePropsOptions): ToolMessagePropsFixture {
  const base = slotPropsFixture(options);
  const result = options.result === undefined ? null : options.result;
  return {
    ...base,
    props: {
      ...base.props,
      toolCallId: options.toolCallId ?? DEFAULT_TOOL_CALL_ID,
      toolName: options.toolName,
      args: options.args ?? {},
      result,
      output: options.output ?? '',
      running: options.running ?? false,
      isError: options.isError ?? false,
    },
  };
}

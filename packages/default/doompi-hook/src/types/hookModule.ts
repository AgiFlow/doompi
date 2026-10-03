import type { PiEventHandlers } from '@agimon-ai/doompi-core/piExtension';
import type {
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';

export type AgentSettledEvent = Parameters<NonNullable<PiEventHandlers['agent_settled']>>[0];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Awaitable<T> = T | Promise<T>;
export interface HookContext {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly agent?: string;
  readonly isSubagent: boolean;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly signal: AbortSignal;
  sendMessage(text: string, delivery: 'steer' | 'followUp'): Promise<void>;
  appendCustomEntry(type: string, data: JsonValue): Promise<void>;
}
export type HookCallResult = Pick<ToolCallEventResult, 'block' | 'reason'>;
export type HookToolResult = Pick<ToolResultEventResult, 'content' | 'details' | 'isError'>;
export type HookModuleResult = HookCallResult | HookToolResult;
export type HookNativeEvent = SessionStartEvent | ToolCallEvent | ToolResultEvent | AgentSettledEvent;
export interface HookHandlers {
  tool_call?(event: ToolCallEvent, ctx: HookContext): Awaitable<HookCallResult | void>;
  tool_result?(event: ToolResultEvent, ctx: HookContext): Awaitable<HookToolResult | void>;
  session_start?(event: SessionStartEvent, ctx: HookContext): Awaitable<void>;
  agent_settled?(event: AgentSettledEvent, ctx: HookContext): Awaitable<void>;
  dispose?(): Awaitable<void>;
}
export interface HookModule {
  setup(ctx: HookContext): Awaitable<HookHandlers>;
}
export interface HookModuleDescriptor {
  version: 1;
  modules: Array<{
    source: string;
    artifact: string;
    receipt: unknown;
    rows: Array<{ registry: string; groupId: string; rowId: string; event: string }>;
  }>;
}

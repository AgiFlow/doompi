import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BashParamsSchema } from '../schemas/bashTool';
import type { LogSummarizer, ToolResult } from './bashResult';
import type { IBashRunService } from './bashRunService';

export interface BashToolDependencies {
  bashRunService: IBashRunService;
  getSessionId(): string | Promise<string>;
  /** Called after a runner is promoted, so UI state can refresh. */
  onRunnerStarted(id: string): void;
  summarizeLog?: LogSummarizer;
}

export type BashToolRenderers = Pick<
  ToolDefinition<typeof BashParamsSchema, ToolResult['details']>,
  'renderCall' | 'renderResult'
>;

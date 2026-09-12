import type { PiEventHandlers } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { BashToolDependencies } from '../types/bashTool';
export interface RunnerRuntime {
  readonly plugin: (this: void, context: Context) => void;
  readonly events: PiEventHandlers;
  readonly command: Parameters<ExtensionAPI['registerCommand']>;
  readonly bashTool: BashToolDependencies;
  start(this: void): void;
  stop(this: void): Promise<void>;
}

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
export interface LoopCommandHandlers {
  start(ctx: ExtensionContext, args: string): Promise<void>;
  list(ctx: ExtensionContext): Promise<void>;
}

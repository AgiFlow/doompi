import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface IFileEditWorkflow {
  open(ctx: ExtensionContext): Promise<void>;
}

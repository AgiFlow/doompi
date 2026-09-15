import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
export interface IdleShutdown {
  cancel(this: void): void;
  settled(context: ExtensionContext): void;
}

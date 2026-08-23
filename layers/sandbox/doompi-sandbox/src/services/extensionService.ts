import { insideSandbox } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import type { SandboxExtensionResult, SandboxExtensionService } from '../types/extension.ts';

const SANDBOXED_MESSAGE = 'Sandboxed session: the agent, extensions, and tools run inside the container.';
const HOST_MESSAGE = 'Host session: relaunch with dpi --sandbox to contain the agent in a container.';

export class DefaultSandboxExtensionService implements SandboxExtensionService {
  private readonly environment: Readonly<Record<string, string | undefined>>;

  constructor(environment: Readonly<Record<string, string | undefined>>) {
    this.environment = environment;
  }

  async execute(): Promise<SandboxExtensionResult> {
    return {
      message: insideSandbox(this.environment) ? SANDBOXED_MESSAGE : HOST_MESSAGE,
      level: 'info',
    };
  }
}

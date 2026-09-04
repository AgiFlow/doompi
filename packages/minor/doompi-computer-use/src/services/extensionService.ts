import type { ComputerUseSessionClient } from '../adapters/pi/sessionApiClient.ts';
import type { ComputerUseExtensionResult, ComputerUseExtensionService } from '../types/extension.ts';

export class DefaultComputerUseExtensionService implements ComputerUseExtensionService {
  public constructor(private readonly client?: ComputerUseSessionClient) {}

  public async execute(): Promise<ComputerUseExtensionResult> {
    if (this.client === undefined)
      return { message: 'Computer use requires a DoomPi Desktop session.', level: 'error' };
    const state = await this.client.state();
    return { message: `Computer use is ${state.phase.replaceAll('_', ' ')}.`, level: 'info' };
  }
}

import type { ComputerUseSessionClient } from '../adapters/pi/sessionApiClient.ts';

export type ComputerUseNotificationLevel = 'info' | 'error';

export interface ComputerUseExtensionResult {
  message: string;
  level: ComputerUseNotificationLevel;
}

export interface ComputerUseExtensionService {
  execute(): Promise<ComputerUseExtensionResult>;
}

export interface ComputerUseExtensionDependencies {
  service: ComputerUseExtensionService;
  client?: ComputerUseSessionClient;
}

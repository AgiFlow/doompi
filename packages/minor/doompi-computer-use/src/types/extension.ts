import type { ComputerUseSessionClient } from '../services/sessionApiClient';
import type { ComputerScriptExecutor } from './computerScript';

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
  scriptRunner?: ComputerScriptExecutor;
  enabled?: () => boolean | Promise<boolean>;
}

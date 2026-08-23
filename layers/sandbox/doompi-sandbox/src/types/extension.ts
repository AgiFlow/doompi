// @scaffold-generated
export type SandboxNotificationLevel = 'info';

export interface SandboxExtensionResult {
  message: string;
  level: SandboxNotificationLevel;
}

export interface SandboxExtensionService {
  execute(): Promise<SandboxExtensionResult>;
}

export interface SandboxExtensionDependencies {
  service: SandboxExtensionService;
}

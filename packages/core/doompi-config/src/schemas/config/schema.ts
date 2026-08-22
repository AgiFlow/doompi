export type PiConfig = Record<string, unknown>;

export interface DoomAdapterSettings {
  projectTrust?: 'ask' | 'always' | 'never';
}

export interface PiConfigPaths {
  canonicalUser: string;
  canonicalProject: string;
  legacyUser: readonly string[];
  legacyProject: readonly string[];
}

export interface PiConfigLoadOptions {
  repoRoot: string;
  homeDirectory?: string;
  defaults?: PiConfig;
  overlay?: PiConfig;
  userConfigPaths?: readonly string[];
  projectConfigPaths?: readonly string[];
  programmatic?: PiConfig;
  environment?: PiConfig;
  cli?: PiConfig;
  isProjectTrusted: boolean | (() => boolean);
}

export interface ConfigAdapterRegistrationOptions {
  defaults?: PiConfig;
  programmatic?: PiConfig;
  environment?: PiConfig;
  cli?: PiConfig;
  homeDirectory?: string;
}

/** Read-only: writes go through the shared config writer in `@agimon-ai/doompi-config`. */
export interface IEditorConfigService {
  /** Shared Doom config, where `editor.command` belongs. */
  path(): string;
  /** Package-scoped fallback for standalone installs with no Doom config. */
  packagePath(): string;
  command(): Promise<string | undefined>;
}

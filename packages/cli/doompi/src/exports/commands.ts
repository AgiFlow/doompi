/**
 * Commands Exports
 */

export { BaseCommand } from '../cli/commands/baseCommand';
export { CompatibilityCommand } from '../cli/commands/compat';
export { DoctorCommand, type DoctorOutput } from '../cli/commands/doctor';
export { EmitMcpCommand } from '../cli/commands/emit-mcp';
export { ExplainCommand, explainMatrix, type MatrixExplanation } from '../cli/commands/explain';
export { InitCommand } from '../cli/commands/init';
export { LaunchCommand } from '../cli/commands/launch';
export {
  collectDrift,
  formatSyncResult,
  recordedEnvironment,
  SyncCommand,
  type SyncCommandOptions,
  type SyncResult,
  type SyncSettingsMode,
  selectionEnvironment,
  toSelection,
} from '../cli/commands/sync';

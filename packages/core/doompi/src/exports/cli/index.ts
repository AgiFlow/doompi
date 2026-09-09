/**
 * CLI Application Exports
 */

export { CliApp, runCli, runHarness } from '../../commands/cli/cliApp';
export { parseCompatibilityArgs, parseCompatibilityProvider } from '../../commands/cli/compatibilityOptions';
// Published so a session server settles the same option matrix the launcher
// does, instead of shelling out to the CLI purely to parse arguments.
export { resolveHarnessOptions, type ResolveHarnessOptionsInput } from '../../commands/cli/harnessOptions';
export { compatHelp, doctorHelp, HARNESS_VERSION, initHelp, printHelp, syncHelp } from '../../commands/cli/help';
export { parseHarnessArgs } from '../../commands/cli/options';
export {
  informationalRequest,
  KNOWN_COMMANDS,
  type KnownCommand,
  routeCommand,
  wantsHelp,
} from '../../commands/cli/router';

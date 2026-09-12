/**
 * CLI Application Exports
 */

export { CliApp, runCli, runHarness } from '../controllers/cliApp';
export { parseCompatibilityArgs, parseCompatibilityProvider } from '../controllers/compatibilityOptions';
// Published so a session server settles the same option matrix the launcher
// does, instead of shelling out to the CLI purely to parse arguments.
export { resolveHarnessOptions, type ResolveHarnessOptionsInput } from '../controllers/harnessOptions';
export { compatHelp, doctorHelp, HARNESS_VERSION, initHelp, printHelp, syncHelp } from '../controllers/help';
export { parseHarnessArgs } from '../controllers/options';
export {
  informationalRequest,
  KNOWN_COMMANDS,
  type KnownCommand,
  routeCommand,
  wantsHelp,
} from '../controllers/router';

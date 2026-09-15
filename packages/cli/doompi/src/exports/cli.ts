/**
 * CLI Application Exports
 */

export { CliApp, runCli, runHarness } from '../cli/cliApp';
export { parseCompatibilityArgs, parseCompatibilityProvider } from '../cli/commands/compat/options';
// Published so a session server settles the same option matrix the launcher
// does, instead of shelling out to the CLI purely to parse arguments.
export { resolveHarnessOptions, type ResolveHarnessOptionsInput } from '../cli/harnessOptions';
export { compatHelp, doctorHelp, HARNESS_VERSION, initHelp, printHelp, syncHelp } from '../cli/help';
export { parseHarnessArgs } from '../cli/options';
export { informationalRequest, KNOWN_COMMANDS, type KnownCommand, routeCommand, wantsHelp } from '../cli/router';

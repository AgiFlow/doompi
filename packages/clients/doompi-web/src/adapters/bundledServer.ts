import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT_COMMAND_ENV = 'DOOMPI_AGENT_COMMAND';
const WEB_MODULE_ENV = 'DOOMPI_WEB_MODULE';
const REPOSITORY_CLI = ['node_modules', '@agimon-ai', 'doompi', 'dist', 'bin', 'cli.mjs'];

export interface BundledServerLaunch {
  readonly command: string;
  /** Leading arguments the command needs; a caller appends its own after these. */
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

type FileExists = (file: string) => boolean;

function packageFile(packageName: string, segments: readonly string[], parentUrl: string): string {
  const manifest = createRequire(parentUrl).resolve(`${packageName}/package.json`);
  return path.join(path.dirname(manifest), ...segments);
}

/** Finds the DoomPi CLI pinned by the repository containing the requested session. */
export function repositoryDoomPiCli(cwd: string, exists: FileExists = fs.existsSync): string | undefined {
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    const cli = path.join(directory, ...REPOSITORY_CLI);
    if (exists(cli)) return cli;
    if (directory === path.dirname(directory)) return undefined;
  }
}

/**
 * Resolves the Server and fallback agent shipped by a DoomPi Web installation.
 *
 * This is what makes `doompi-web` need no flags: the hub launches the
 * doompi-server sitting in its own dependency tree rather than whichever one
 * PATH happens to name, and points it at the agent from the same install, so a
 * checkout runs its own build. A repository that pins its own DoomPi still
 * wins, since a session created there should run that repository's agent.
 */
export function defaultServerLaunch(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  parentUrl: string = import.meta.url,
  exists: FileExists = fs.existsSync,
): BundledServerLaunch {
  const server = packageFile('@agimon-ai/doompi-server', ['dist', 'bin', 'serve.mjs'], parentUrl);
  const bundledAgent = packageFile('@agimon-ai/doompi', ['dist', 'bin', 'cli.mjs'], parentUrl);
  const bundledWeb = packageFile('@agimon-ai/doompi-web', ['dist', 'index.mjs'], parentUrl);
  const configuredAgent = environment[AGENT_COMMAND_ENV];
  const localAgent = repositoryDoomPiCli(cwd, exists);
  const agentEnvironment =
    configuredAgent || localAgent ? { ...environment } : { ...environment, [AGENT_COMMAND_ENV]: bundledAgent };

  return {
    command: process.execPath,
    args: [server],
    environment: {
      ...agentEnvironment,
      [WEB_MODULE_ENV]: environment[WEB_MODULE_ENV] || pathToFileURL(bundledWeb).href,
    },
  };
}

import fs from 'node:fs';
import os from 'node:os';
import {
  type GlobalDoomInitResult,
  globalDoomConfigDirectory,
  initializeGlobalDoomConfig,
} from '@agimon-ai/doompi-config';
import { writePiExtensionAlias } from '../adapters/piExtensionAlias.ts';
import { piAgentDirectory, piThemeDirectory, readPiSettings, writePiSettings } from '../adapters/piSettings.ts';
import { DEFAULT_THEME_NAME, writeDefaultTheme } from '@agimon-ai/doompi-ui/theme';
import { InitPresenter, type InitOutput, type PiIntegrationSummary } from './initPresenter.ts';

const INIT_COMMAND = 'init';
const FORCE_FLAG = '--force';
const SETUP_STAGE_COUNT = 2;

function setupFailure(activity: string, target: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`doompi init failed while ${activity} at ${target}: ${detail}`, { cause: error });
}

async function initializePiIntegration(
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<PiIntegrationSummary> {
  const agentDirectory = piAgentDirectory(environment, homeDirectory);
  const before = readPiSettings(agentDirectory);
  const themeDirectory = piThemeDirectory(agentDirectory);
  await fs.promises.mkdir(themeDirectory, { recursive: true });
  const themePath = await writeDefaultTheme(themeDirectory);
  const aliasPath = writePiExtensionAlias(agentDirectory);
  const settingsPath = writePiSettings(agentDirectory, { themePath, themeName: DEFAULT_THEME_NAME });
  return {
    settingsPath,
    themePath,
    aliasPath,
    before,
    after: readPiSettings(agentDirectory),
  };
}

/** Handles the repository-independent `doompi init` command. */
export class InitCommand {
  readonly name = INIT_COMMAND;

  matches(args: string[]): boolean {
    return args[0] === this.name;
  }

  async execute(
    args: string[],
    homeDirectory = os.homedir(),
    output: InitOutput = process.stdout,
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<number> {
    const flags = args.slice(1);
    const unknown = flags.find((flag) => flag !== FORCE_FLAG);
    if (unknown !== undefined) throw new Error(`doompi init does not accept ${unknown}`);

    const presenter = new InitPresenter(output, environment);
    presenter.brand();

    const configDirectory = globalDoomConfigDirectory(homeDirectory);
    presenter.stage(1, SETUP_STAGE_COUNT, 'WRITE CONFIGURATION', configDirectory);
    let configResult: GlobalDoomInitResult;
    try {
      configResult = initializeGlobalDoomConfig(homeDirectory, { force: flags.includes(FORCE_FLAG) });
      presenter.stageReady('Configuration files are ready.');
    } catch (error) {
      presenter.stageFailed('Configuration setup failed.', [
        'Fix the reported path or permissions, then run doompi init again.',
      ]);
      throw setupFailure('writing configuration', configDirectory, error);
    }

    const agentDirectory = piAgentDirectory(environment, homeDirectory);
    presenter.stage(2, SETUP_STAGE_COUNT, 'REGISTER WITH PI', agentDirectory);
    let piResult: PiIntegrationSummary;
    try {
      piResult = await initializePiIntegration(homeDirectory, environment);
      presenter.stageReady('Pi integration is ready.');
    } catch (error) {
      presenter.stageFailed('Pi integration failed.', [
        `Your DoomPi configuration remains at ${configResult.directory}.`,
        'Fix the reported settings or filesystem issue, then run doompi init again.',
      ]);
      throw setupFailure('registering with Pi', agentDirectory, error);
    }

    presenter.complete(configResult, piResult);
    return 0;
  }
}

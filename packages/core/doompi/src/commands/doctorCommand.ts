import os from 'node:os';
import path from 'node:path';
import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { missingLayerPackageSpecifiers } from '../adapters/layerPackageInstaller.ts';
import { resolveDoomConfigurationRoot } from '../adapters/repository/repository';
import { readLocatedSyncState } from '../adapters/syncState.ts';
import { loadDoomConfig } from '../services/config/projectTrust';
import { createLayerResolvers } from '../services/extensionAssembler.ts';
import { doctorHelp } from './cli/help.ts';
import { parseHarnessArgs } from './cli/options.ts';
import { wantsHelp } from './cli/router.ts';
import { collectDrift, selectionCompositionFingerprint, selectionEnvironment, toSelection } from './syncCommand.ts';

const DOCTOR_COMMAND = 'doctor';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const LABEL_WIDTH = 14;

export interface DoctorOutput {
  write(chunk: string): void;
}

/** One checked area and what it found. Empty problems means the section passed. */
interface Section {
  label: string;
  problems: string[];
}

function formatSection(section: Section): string {
  const label = section.label.padEnd(LABEL_WIDTH);
  if (section.problems.length === 0) return `${label}ok\n`;
  return `${label}${section.problems.length === 1 ? 'FAILED' : `${String(section.problems.length)} problem(s)`}\n${section.problems
    .map((problem) => `  ${problem}\n`)
    .join('')}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one check, turning the throw a strict parser uses into a reported problem. */
function check(run: () => void): string[] {
  try {
    run();
    return [];
  } catch (error) {
    return [messageOf(error)];
  }
}

/**
 * Reports what is wrong with a DoomPi installation without changing anything.
 *
 * The strict counterpart to `doompi sync`, which tolerates unknown config keys
 * so a build cannot break over one. Everything `sync --check` reports is
 * reported here too, so this is the one command to run when something is off.
 */
export class DoctorCommand {
  readonly name = DOCTOR_COMMAND;

  matches(args: string[]): boolean {
    return args[0] === this.name;
  }

  execute(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
    currentDirectory = process.cwd(),
    output: DoctorOutput = process.stdout,
  ): number {
    if (wantsHelp(args.slice(1))) {
      output.write(doctorHelp());
      return 0;
    }
    const homeDirectory = environment.HOME ?? os.homedir();
    const inheritedRoot = environment[HARNESS_ROOT_ENV];
    const repoRoot = inheritedRoot
      ? path.resolve(inheritedRoot)
      : resolveDoomConfigurationRoot(currentDirectory, homeDirectory);

    const sections: Section[] = [
      { label: 'config.yaml', problems: check(() => loadDoomConfig(repoRoot)) },
      { label: 'modes.yaml', problems: check(() => loadMajorModesConfig(repoRoot, homeDirectory)) },
    ];
    // Everything below reads the resolved composition, which cannot be trusted
    // while either file is still unreadable.
    const configurationIsSound = sections.every((section) => section.problems.length === 0);
    if (configurationIsSound)
      sections.push(...this.installationSections(repoRoot, homeDirectory, environment, currentDirectory));

    for (const section of sections) output.write(formatSection(section));
    const problems = sections.reduce((total, section) => total + section.problems.length, 0);
    if (problems === 0) {
      output.write('\nno problems found\n');
      return 0;
    }
    output.write(`\n${String(problems)} problem(s) found\n`);
    return 1;
  }

  /** Package, sync-state and drift checks, mirroring what `sync --check` reports. */
  private installationSections(
    repoRoot: string,
    homeDirectory: string,
    environment: NodeJS.ProcessEnv,
    currentDirectory: string,
  ): Section[] {
    const majorModesConfig = loadMajorModesConfig(repoRoot, homeDirectory);
    const packages = missingLayerPackageSpecifiers(
      majorModesConfig,
      Object.keys(majorModesConfig.layers),
      createLayerResolvers(repoRoot),
    ).map((specifier) => `configured package is not installed: ${specifier}`);

    let state: Awaited<ReturnType<typeof readLocatedSyncState>>;
    try {
      state = readLocatedSyncState(repoRoot, homeDirectory);
    } catch (error) {
      return [
        { label: 'packages', problems: packages },
        { label: 'sync state', problems: [messageOf(error)] },
      ];
    }

    const parsed = parseHarnessArgs(
      [],
      selectionEnvironment(repoRoot, environment),
      currentDirectory,
      majorModesConfig.defaultMajorMode,
      loadDomains(repoRoot, homeDirectory).defaultDomains,
    );
    const drift = collectDrift(
      repoRoot,
      toSelection(parsed.options),
      state?.state,
      environment,
      'persisted',
      selectionCompositionFingerprint(repoRoot, parsed.options, homeDirectory),
    );
    return [
      { label: 'packages', problems: packages },
      { label: 'sync state', problems: [] },
      { label: 'drift', problems: drift },
    ];
  }
}

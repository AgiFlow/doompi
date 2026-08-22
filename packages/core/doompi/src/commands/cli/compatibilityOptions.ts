import type { CompatibilityProvider, ParsedCompatibilityArgs } from '../../types/interfaces/compatibility';
import { defaultDomainsForMajorMode } from '@agimon-ai/doompi-config/domains';
import {
  DOMAIN_OPTION,
  DOMAINS_OPTION,
  MAJOR_MODE_OPTION,
  matchesOption,
  PROFILE_OPTION,
  parseMajorMode,
  parseProfileValue,
  parseRequiredCsv,
  REMOVED_LAYER_OPTION,
  REMOVED_LAYERS_OPTION,
  REMOVED_TARGET_OPTION,
  readOption,
  resolveAdditionalDirectories,
  resolveInheritedMajorMode,
  resolveInheritedProfile,
} from './matrixOptions.ts';

const COMPATIBILITY_PROVIDERS = new Set<CompatibilityProvider>(['antigravity', 'claude', 'codex']);
const PROVIDER_ARGUMENT_SEPARATOR = '--';
const SKIP_PERMISSIONS_OPTION = '--skip-permissions';

export function parseCompatibilityProvider(value: string | undefined): CompatibilityProvider {
  if (!value || !COMPATIBILITY_PROVIDERS.has(value as CompatibilityProvider)) {
    throw new Error(`compat requires one of: ${[...COMPATIBILITY_PROVIDERS].join(', ')}`);
  }
  return value as CompatibilityProvider;
}

/**
 * Parses only the matrix options shared by every frontend.
 *
 * Every other argument remains untouched for the selected provider. In
 * particular, Pi aliases such as --effort and --output-format are not rewritten.
 * Use -- to pass a provider-native --profile, --domain, or --major-mode option.
 */
export function parseCompatibilityArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  defaultMajorMode?: string,
  defaultDomains?: readonly string[],
): ParsedCompatibilityArgs {
  let profile = resolveInheritedProfile(environment);
  let profileProvided = false;
  let majorMode = resolveInheritedMajorMode(environment, defaultMajorMode);
  let majorModeProvided = false;
  const domains: string[] = [];
  const providerArgs: string[] = [];
  let skipPermissions = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === PROVIDER_ARGUMENT_SEPARATOR) {
      providerArgs.push(...args.slice(index + 1));
      break;
    }
    if (matchesOption(arg, REMOVED_TARGET_OPTION)) {
      throw new Error(`${REMOVED_TARGET_OPTION} was replaced by ${MAJOR_MODE_OPTION}`);
    }
    if (matchesOption(arg, REMOVED_LAYER_OPTION)) {
      throw new Error(`${REMOVED_LAYER_OPTION} was replaced by ${MAJOR_MODE_OPTION}`);
    }
    if (matchesOption(arg, REMOVED_LAYERS_OPTION)) {
      throw new Error(`${REMOVED_LAYERS_OPTION} was removed; select one major mode with ${MAJOR_MODE_OPTION}`);
    }

    if (matchesOption(arg, SKIP_PERMISSIONS_OPTION)) {
      if (arg !== SKIP_PERMISSIONS_OPTION) throw new Error(`${SKIP_PERMISSIONS_OPTION} does not take a value`);
      skipPermissions = true;
      continue;
    }

    const majorModeMatch = readOption(args, index, MAJOR_MODE_OPTION);
    if (majorModeMatch) {
      if (majorModeProvided) throw new Error(`${MAJOR_MODE_OPTION} can only be provided once`);
      majorMode = parseMajorMode(majorModeMatch.value, MAJOR_MODE_OPTION);
      majorModeProvided = true;
      index = majorModeMatch.nextIndex;
      continue;
    }

    const profileMatch = readOption(args, index, PROFILE_OPTION);
    if (profileMatch) {
      if (profileProvided) throw new Error(`${PROFILE_OPTION} can only be provided once`);
      profile = parseProfileValue(profileMatch.value, PROFILE_OPTION);
      profileProvided = true;
      index = profileMatch.nextIndex;
      continue;
    }

    const domainMatch = readOption(args, index, DOMAINS_OPTION) ?? readOption(args, index, DOMAIN_OPTION);
    if (domainMatch) {
      domains.push(
        ...parseRequiredCsv(domainMatch.value, matchesOption(arg, DOMAINS_OPTION) ? DOMAINS_OPTION : DOMAIN_OPTION),
      );
      index = domainMatch.nextIndex;
      continue;
    }

    providerArgs.push(arg);
  }

  if (domains.length === 0) domains.push(...defaultDomainsForMajorMode(majorMode, environment, defaultDomains));

  return {
    options: {
      currentDirectory,
      profile,
      domains,
      majorMode,
      providerArgs,
      additionalDirectories: [...new Set(resolveAdditionalDirectories(environment, currentDirectory))],
      skipPermissions,
    },
  };
}

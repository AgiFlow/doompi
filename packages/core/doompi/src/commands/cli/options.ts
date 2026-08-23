import path from 'node:path';
import type { HarnessOutputFormat, HarnessPreset, ParsedHarnessArgs } from '../../types/interfaces/harness';
import { defaultDomainsForMajorMode } from '@agimon-ai/doompi-config/domains';
import {
  ADD_DIRECTORY_OPTION,
  DEFAULT_MAJOR_MODE,
  DOMAIN_OPTION,
  DOMAINS_OPTION,
  DOOMPI_PRESET_ENV,
  MAJOR_MODE_OPTION,
  matchesOption,
  PROFILE_OPTION,
  parseCsv,
  parseMajorMode,
  parseProfileValue,
  REMOVED_LAYER_OPTION,
  REMOVED_LAYERS_OPTION,
  REMOVED_TARGET_OPTION,
  readOption,
  resolveAdditionalDirectories,
  resolveInheritedMajorMode,
  resolveInheritedProfile,
} from './matrixOptions.ts';

const KIMI_FOR_CODING = 'kimi-for-coding';
const KIMI_FOR_CODING_HIGHSPEED = 'kimi-for-coding-highspeed';
const KIMI_K2_6 = 'kimi-k2.6';
const DEFAULT_PRESET = 'default';
const KIMI_PRESET = 'kimi';
const OLLAMA_PRESET = 'ollama';
const OLLAMA_PREFIX = 'ollama/';
const KIMI_CODING_PREFIX = 'kimi-coding/';
const CLOUD_SUFFIX = ':cloud';
const NATIVE_FORMAT = 'native';
const KIMI_CODE_MODEL_ENV = 'KIMI_CODE_MODEL';
const OLLAMA_CLAUDE_MODEL_ENV = 'OLLAMA_CLAUDE_MODEL';
const MODEL_OPTION = '--model';
const MODEL_SHORT_OPTION = '-m';
const MODE_OPTION = '--mode';
const THINKING_OPTION = '--thinking';
const PRINT_OPTION = '--print';
const PRINT_SHORT_OPTION = '-p';
const APPROVE_OPTION = '--approve';
const APPROVE_SHORT_OPTION = '-a';
const PROFILES_OPTION = '--profiles';
const NO_DOMAINS_OPTION = '--no-domains';
const PRESET_OPTION = '--preset';
const EFFORT_OPTION = '--effort';
const OUTPUT_FORMAT_OPTION = '--output-format';
const MUTE_OPTION = '--mute';
const VIBE_LINT_FORMAT = 'vibe-lint';
const STREAM_JSON_FORMAT = 'stream-json';
const JSON_FORMAT = 'json';
const EXPLAIN_OPTION = '--explain';
const EMIT_MCP_OPTION = '--emit-mcp';
const PLUGIN_DIRECTORY_OPTION = '--plugin-dir';
const CWD_OPTION = '--cwd';
const CD_OPTION = '--cd';
const AUTOMATION_OPTION = '--automation';
const AUTO_STOP_OPTION = '--auto-stop';
const SANDBOX_OPTION = '--sandbox';
const ALLOW_PROTECTED_WRITES_OPTION = '--allow-protected-writes';
const HOOKS_OPTION = '--hooks';
const MCP_OPTION = '--mcp';
const AGENTS_OPTION = '--agents';
const NO_HOOKS_OPTION = '--no-hooks';
const NO_MCP_OPTION = '--no-mcp';
const NO_AGENTS_OPTION = '--no-agents';
const VERBOSE_OPTION = '--verbose';
const DANGEROUSLY_SKIP_PERMISSIONS_OPTION = '--dangerously-skip-permissions';
const HELP_OPTION = '--help';
const HELP_SHORT_OPTION = '-h';
const VERSION_OPTION = '--version';
const VERSION_SHORT_OPTION = '-v';

const KIMI_ALIASES = new Map([
  ['k2p5', KIMI_FOR_CODING],
  ['k2p6', KIMI_FOR_CODING],
  ['k2p7', KIMI_FOR_CODING],
  ['kimi-k2.5', KIMI_FOR_CODING],
  [KIMI_K2_6, KIMI_FOR_CODING],
  ['kimi-k2.7-code', KIMI_FOR_CODING],
  [KIMI_FOR_CODING, KIMI_FOR_CODING],
  [KIMI_FOR_CODING_HIGHSPEED, KIMI_FOR_CODING_HIGHSPEED],
]);

function parsePreset(value: string): HarnessPreset {
  if (value === DEFAULT_PRESET || value === KIMI_PRESET || value === OLLAMA_PRESET) return value;
  throw new Error(`Unsupported preset: ${value}`);
}

function hasOption(args: string[], ...names: string[]): boolean {
  return args.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)));
}

function modelValue(args: string[]): { index: number; value: string; inline: boolean } | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === MODEL_OPTION || args[index] === MODEL_SHORT_OPTION) {
      const value = args[index + 1];
      if (value) return { index, value, inline: false };
    }
    if (args[index]?.startsWith(`${MODEL_OPTION}=`)) {
      return { index, value: args[index].slice(`${MODEL_OPTION}=`.length), inline: true };
    }
  }
  return undefined;
}

function replaceModel(args: string[], value: string): void {
  const selected = modelValue(args);
  if (!selected) {
    args.unshift(MODEL_OPTION, value);
  } else if (selected.inline) {
    args[selected.index] = `${MODEL_OPTION}=${value}`;
  } else {
    args[selected.index + 1] = value;
  }
}

function normalizeProviderArgs(preset: HarnessPreset, piArgs: string[], environment: NodeJS.ProcessEnv): void {
  const selected = modelValue(piArgs);
  if (preset === KIMI_PRESET) {
    const value = selected?.value ?? environment[KIMI_CODE_MODEL_ENV] ?? KIMI_FOR_CODING;
    const unqualified = value.includes('/') ? value.slice(value.indexOf('/') + 1) : value;
    replaceModel(piArgs, `${KIMI_CODING_PREFIX}${KIMI_ALIASES.get(unqualified) ?? unqualified}`);
  }
  if (preset === OLLAMA_PRESET) {
    const value = selected?.value ?? environment[OLLAMA_CLAUDE_MODEL_ENV] ?? KIMI_K2_6;
    const unqualified = value.startsWith(OLLAMA_PREFIX) ? value.slice(OLLAMA_PREFIX.length) : value;
    replaceModel(
      piArgs,
      `${OLLAMA_PREFIX}${unqualified.includes(':') ? unqualified : `${unqualified}${CLOUD_SUFFIX}`}`,
    );
  }
}

/**
 * Answers `--help` and `--version` without reading the environment.
 *
 * The caller only looks at `help` and `version` for these, and never launches,
 * so the options carry defaults rather than a resolved matrix. This exists so a
 * stale export cannot break the one command that explains how to fix it.
 */
function parseInformationalArgs(args: string[], currentDirectory: string): ParsedHarnessArgs | undefined {
  const help = args.some((arg) => arg === HELP_OPTION || arg === HELP_SHORT_OPTION);
  const version = args.some((arg) => arg === VERSION_OPTION || arg === VERSION_SHORT_OPTION);
  if (!help && !version) return undefined;
  return {
    options: {
      cwd: currentDirectory,
      profile: undefined,
      domains: [],
      majorMode: DEFAULT_MAJOR_MODE,
      explain: false,
      emitMcp: undefined,
      pluginDirectories: [],
      additionalDirectories: [],
      preset: DEFAULT_PRESET,
      outputFormat: NATIVE_FORMAT,
      mute: false,
      automation: false,
      autoStop: false,
      sandbox: false,
      allowProtectedWrites: false,
      hooks: true,
      mcp: true,
      agents: true,
      piArgs: [],
    },
    help,
    version,
  };
}

export function parseHarnessArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  defaultMajorMode: string = DEFAULT_MAJOR_MODE,
  defaultDomains?: readonly string[],
): ParsedHarnessArgs {
  const informational = parseInformationalArgs(args, currentDirectory);
  if (informational) return informational;

  let profile = resolveInheritedProfile(environment);
  let profileProvided = false;
  let majorMode = resolveInheritedMajorMode(environment, defaultMajorMode);
  let majorModeProvided = false;
  const domains: string[] = [];
  // Directory options are collected verbatim and resolved once after the loop,
  // so a relative path means the same thing regardless of where --cwd appears
  // in the argument list.
  const pluginDirectoryValues: string[] = [];
  const additionalDirectoryValues: string[] = [];
  const piArgs: string[] = [];
  let cwd = currentDirectory;
  let preset = parsePreset(environment[DOOMPI_PRESET_ENV] ?? DEFAULT_PRESET);
  let outputFormat: HarnessOutputFormat = NATIVE_FORMAT;
  let domainsDisabled = false;
  let mute = false;
  let automation = false;
  let autoStop = false;
  let sandbox = false;
  let allowProtectedWrites = false;
  let hooks = true;
  let mcp = true;
  let agents = true;
  let help = false;
  let version = false;
  let explain = false;
  let emitMcp: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (matchesOption(arg, REMOVED_TARGET_OPTION)) {
      throw new Error(`${REMOVED_TARGET_OPTION} was replaced by ${MAJOR_MODE_OPTION}`);
    }
    if (matchesOption(arg, REMOVED_LAYER_OPTION)) {
      throw new Error(`${REMOVED_LAYER_OPTION} was replaced by ${MAJOR_MODE_OPTION}`);
    }
    if (matchesOption(arg, REMOVED_LAYERS_OPTION)) {
      throw new Error(`${REMOVED_LAYERS_OPTION} was removed; select one major mode with ${MAJOR_MODE_OPTION}`);
    }
    if (matchesOption(arg, PROFILES_OPTION)) {
      throw new Error(`${PROFILES_OPTION} was replaced by ${DOMAINS_OPTION}`);
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
      domains.push(...parseCsv(domainMatch.value));
      index = domainMatch.nextIndex;
      continue;
    }

    const emitMcpMatch = readOption(args, index, EMIT_MCP_OPTION);
    if (emitMcpMatch) {
      emitMcp = path.resolve(currentDirectory, emitMcpMatch.value);
      index = emitMcpMatch.nextIndex;
      continue;
    }

    const pluginDirectoryMatch = readOption(args, index, PLUGIN_DIRECTORY_OPTION);
    if (pluginDirectoryMatch) {
      pluginDirectoryValues.push(pluginDirectoryMatch.value);
      index = pluginDirectoryMatch.nextIndex;
      continue;
    }

    const addDirectoryMatch = readOption(args, index, ADD_DIRECTORY_OPTION);
    if (addDirectoryMatch) {
      additionalDirectoryValues.push(addDirectoryMatch.value);
      index = addDirectoryMatch.nextIndex;
      continue;
    }

    const presetMatch = readOption(args, index, PRESET_OPTION);
    if (presetMatch) {
      preset = parsePreset(presetMatch.value);
      index = presetMatch.nextIndex;
      continue;
    }

    const cwdMatch = readOption(args, index, CWD_OPTION) ?? readOption(args, index, CD_OPTION);
    if (cwdMatch) {
      cwd = path.resolve(currentDirectory, cwdMatch.value);
      index = cwdMatch.nextIndex;
      continue;
    }

    const effortMatch = readOption(args, index, EFFORT_OPTION);
    if (effortMatch) {
      if (effortMatch.inline) piArgs.push(`${THINKING_OPTION}=${effortMatch.value}`);
      else piArgs.push(THINKING_OPTION, effortMatch.value);
      index = effortMatch.nextIndex;
      continue;
    }

    const outputFormatMatch = readOption(args, index, OUTPUT_FORMAT_OPTION);
    if (outputFormatMatch) {
      const requested = outputFormatMatch.value;
      if (requested === VIBE_LINT_FORMAT) {
        outputFormat = VIBE_LINT_FORMAT;
      } else {
        const mode = requested === STREAM_JSON_FORMAT ? JSON_FORMAT : requested;
        if (outputFormatMatch.inline) piArgs.push(`${MODE_OPTION}=${mode}`);
        else piArgs.push(MODE_OPTION, mode);
      }
      index = outputFormatMatch.nextIndex;
      continue;
    }

    if (arg === NO_DOMAINS_OPTION) domainsDisabled = true;
    else if (arg === EXPLAIN_OPTION) explain = true;
    else if (arg === AUTOMATION_OPTION) automation = true;
    else if (arg === MUTE_OPTION) mute = true;
    else if (arg === AUTO_STOP_OPTION) autoStop = true;
    else if (arg === SANDBOX_OPTION) sandbox = true;
    else if (arg === ALLOW_PROTECTED_WRITES_OPTION) allowProtectedWrites = true;
    else if (arg === HOOKS_OPTION) hooks = true;
    else if (arg === MCP_OPTION) mcp = true;
    else if (arg === AGENTS_OPTION) agents = true;
    else if (arg === NO_HOOKS_OPTION) hooks = false;
    else if (arg === NO_MCP_OPTION) mcp = false;
    else if (arg === NO_AGENTS_OPTION) agents = false;
    else if (arg === HELP_OPTION || arg === HELP_SHORT_OPTION) help = true;
    else if (arg === VERSION_OPTION || arg === VERSION_SHORT_OPTION) version = true;
    // Accepted for Claude Code compatibility and deliberately not forwarded.
    else if (arg !== VERBOSE_OPTION && arg !== DANGEROUSLY_SKIP_PERMISSIONS_OPTION) piArgs.push(arg);
  }

  if (domainsDisabled && domains.length > 0) {
    throw new Error(`${NO_DOMAINS_OPTION} cannot be combined with ${DOMAINS_OPTION}`);
  }
  if (!domainsDisabled && domains.length === 0 && pluginDirectoryValues.length === 0) {
    domains.push(...defaultDomainsForMajorMode(majorMode, environment, defaultDomains));
  }
  if (automation) {
    if (!hasOption(piArgs, PRINT_OPTION, PRINT_SHORT_OPTION)) piArgs.unshift(PRINT_OPTION);
    if (!hasOption(piArgs, MODE_OPTION)) piArgs.unshift(MODE_OPTION, JSON_FORMAT);
    if (!hasOption(piArgs, APPROVE_OPTION, APPROVE_SHORT_OPTION)) piArgs.unshift(APPROVE_OPTION);
  }
  if (
    autoStop &&
    (automation ||
      outputFormat === VIBE_LINT_FORMAT ||
      hasOption(piArgs, PRINT_OPTION, PRINT_SHORT_OPTION, MODE_OPTION))
  ) {
    throw new Error(`${AUTO_STOP_OPTION} only supports interactive Pi mode`);
  }
  normalizeProviderArgs(preset, piArgs, environment);

  return {
    options: {
      cwd,
      profile,
      domains,
      majorMode,
      explain,
      emitMcp,
      pluginDirectories: pluginDirectoryValues.map((value) => path.resolve(currentDirectory, value)),
      additionalDirectories: [
        ...new Set([
          ...resolveAdditionalDirectories(environment, currentDirectory),
          ...additionalDirectoryValues.map((value) => path.resolve(currentDirectory, value)),
        ]),
      ],
      preset,
      outputFormat,
      mute,
      automation,
      autoStop,
      sandbox,
      allowProtectedWrites,
      hooks,
      mcp,
      agents,
      piArgs,
    },
    help,
    version,
  };
}

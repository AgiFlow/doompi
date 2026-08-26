import spawn from 'cross-spawn';
import { forwardSignals, waitForExit } from '../adapters/compatibility/process.ts';
import { HARNESS_EVENT, type HarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry.ts';
import { hasProjectTrustOption } from '../services/config/projectTrust';
import type { HarnessContext } from '../adapters/harnessContext';
import type { HarnessOptions } from '../types/interfaces/harness';
import { resolveLaunchPlan } from '../adapters/launchPlan.ts';
import { piCliPath } from '../adapters/modules/moduleResolution';
import { isRecord } from '../adapters/serialization/json';
import { BaseCommand } from './baseCommand.ts';

const VIBE_LINT_FORMAT = 'vibe-lint';
const PRINT_OPTION = '--print';
const APPROVE_OPTION = '--approve';
const NO_SESSION_OPTION = '--no-session';
const SYSTEM_PROMPT_OPTION = '--system-prompt';
const IGNORE_STDIO = 'ignore';
const PIPE_STDIO = 'pipe';
const INHERIT_STDIO = 'inherit';

export interface VibeLintInvocation {
  prompt: string;
  systemPrompt: string;
  maxTokens?: number;
  screenshotPaths?: string[];
}

export function parseVibeLintInvocation(input: string): VibeLintInvocation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error('Expected a JSON vibe-lint invocation on stdin', { cause: error });
  }

  if (!isRecord(parsed) || typeof parsed.prompt !== 'string' || typeof parsed.systemPrompt !== 'string') {
    throw new Error('A vibe-lint invocation requires string prompt and systemPrompt fields');
  }
  if (parsed.maxTokens !== undefined && typeof parsed.maxTokens !== 'number') {
    throw new Error('A vibe-lint invocation maxTokens field must be a number');
  }
  if (
    parsed.screenshotPaths !== undefined &&
    (!Array.isArray(parsed.screenshotPaths) || !parsed.screenshotPaths.every((value) => typeof value === 'string'))
  ) {
    throw new Error('A vibe-lint invocation screenshotPaths field must be an array of strings');
  }

  return {
    prompt: parsed.prompt,
    systemPrompt: parsed.systemPrompt,
    maxTokens: parsed.maxTokens,
    screenshotPaths: parsed.screenshotPaths as string[] | undefined,
  };
}

export function buildVibeLintPiArgs(piArgs: string[], invocation: VibeLintInvocation): string[] {
  return [
    ...piArgs,
    PRINT_OPTION,
    ...(!hasProjectTrustOption(piArgs) ? [APPROVE_OPTION] : []),
    // Reviews are disposable and must not appear in Pi's resume history.
    NO_SESSION_OPTION,
    SYSTEM_PROMPT_OPTION,
    invocation.systemPrompt,
    ...(invocation.screenshotPaths ?? []).map((screenshotPath) => `@${screenshotPath}`),
    invocation.prompt,
  ];
}

export function formatVibeLintResponse(content: string): string {
  return `${JSON.stringify({ content: content.trim() })}\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Spawns Pi with the resolved extensions, environment, and theme.
 *
 * This is the default command: it matches whenever no diagnostic flag claimed
 * the run.
 */
export class LaunchCommand extends BaseCommand {
  readonly name = 'launch';

  matches(_options: HarnessOptions): boolean {
    return true;
  }

  async execute(context: HarnessContext, telemetry: HarnessTelemetry): Promise<number> {
    const { options } = context;
    const plan = await resolveLaunchPlan(context, telemetry);
    const environment = plan.environment;
    let piArgs = plan.piArgs;
    const launchExtensions = plan.extensions;

    if (options.outputFormat === VIBE_LINT_FORMAT) {
      const invocation = parseVibeLintInvocation(await readStdin());
      piArgs = buildVibeLintPiArgs(piArgs, invocation);
    }

    const startedAt = Date.now();
    const child = spawn(process.execPath, [piCliPath(), ...piArgs], {
      cwd: options.cwd,
      env: environment,
      stdio: options.outputFormat === VIBE_LINT_FORMAT ? [IGNORE_STDIO, PIPE_STDIO, PIPE_STDIO] : INHERIT_STDIO,
    });
    let stdout = '';
    if (options.outputFormat === VIBE_LINT_FORMAT) {
      if (!child.stdout || !child.stderr) throw new Error('Failed to open Pi output streams');
      child.stdout.on('data', (chunk: string | Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: string | Buffer) => {
        process.stderr.write(chunk);
      });
    }

    // Shared with the compatibility providers, so a second Ctrl-C still reaches
    // the child and SIGHUP and SIGQUIT are forwarded too.
    const stopForwarding = forwardSignals(child);
    const result = await telemetry
      .runInSpan(
        'doom_pi.pi_session',
        {
          'harness.extension.count': launchExtensions.length,
          'harness.mode': options.outputFormat,
        },
        () => waitForExit(child),
      )
      .catch(async (error: unknown) => {
        // A spawn error means Pi never started, which is invisible to the
        // session telemetry the child would otherwise have reported.
        await telemetry.recordError(HARNESS_EVENT.launchFailed, error, {
          'harness.duration_ms': Date.now() - startedAt,
        });
        throw error;
      })
      .finally(stopForwarding);

    void telemetry.recordEvent(HARNESS_EVENT.launchCompleted, {
      'harness.exit_code': result,
      'harness.duration_ms': Date.now() - startedAt,
      'harness.mode': options.outputFormat ?? 'default',
    });

    if (options.outputFormat === VIBE_LINT_FORMAT && result === 0) {
      process.stdout.write(formatVibeLintResponse(stdout));
    }
    return result;
  }
}

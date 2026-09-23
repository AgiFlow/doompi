import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { Cron } from 'croner';

import { NOTIFY_WARNING_LEVEL, PACKAGE_SOURCE } from '../../constants/piLoop';
import type {
  DoomLoopLaunchersService,
  LoopLaunchRequest,
  LoopLauncherRegistration,
} from '../../schemas/loopLaunchers';
import { CronLoopSchema, IntervalLoopSchema, parseCronLoop, parseIntervalLoop } from '../../schemas/loopTools';

const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 3600;
const MILLISECONDS_PER_SECOND = 1000;
const PROMPT_PREVIEW_LENGTH = 80;

interface ActiveDefaultLoop {
  readonly prompt: string;
  readonly context: ExtensionContext;
  stopped: boolean;
}

export interface DefaultLoopLauncher {
  onAgentSettled(this: void): void;
  register(ctx: ExtensionContext, launchers: DoomLoopLaunchersService): LoopLauncherRegistration;
  registerCron(ctx: ExtensionContext, launchers: DoomLoopLaunchersService): LoopLauncherRegistration;
}

async function prepareLoop(ui: ExtensionUIContext, request: LoopLaunchRequest, cron: boolean) {
  if (request.input !== undefined) return cron ? parseCronLoop(request.input) : parseIntervalLoop(request.input);
  if (request.interactive === false) throw new Error('Loop configuration is required for agent launches.');
  const prompt = (await ui.editor('Loop prompt', ''))?.trim();
  if (!prompt || request.signal.aborted) return undefined;
  if (cron) {
    const expression = await ui.input('Cron expression (five fields)', '0 * * * *');
    if (expression === undefined || request.signal.aborted) return undefined;
    const timezone = await ui.input('Loop timezone', 'UTC');
    if (timezone === undefined || request.signal.aborted) return undefined;
    return parseCronLoop({ prompt, cron: expression, timezone: timezone.trim() || 'UTC' });
  }
  const raw = await ui.input('Loop interval in seconds', `Default: ${DEFAULT_INTERVAL_SECONDS}s`);
  if (raw === undefined || request.signal.aborted) return undefined;
  const intervalSeconds = Number(raw.trim() || DEFAULT_INTERVAL_SECONDS);
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    ui.notify(
      `Interval must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`,
      NOTIFY_WARNING_LEVEL,
    );
    return undefined;
  }
  return parseIntervalLoop({ prompt, intervalSeconds });
}

function promptPreview(prompt: string): string {
  const oneLine = prompt.replaceAll(/\s+/gu, ' ').trim();
  return oneLine.length > PROMPT_PREVIEW_LENGTH ? `${oneLine.slice(0, PROMPT_PREVIEW_LENGTH - 1)}…` : oneLine;
}

export function createDefaultLoopLauncher(pi: Pick<ExtensionAPI, 'sendUserMessage'>): DefaultLoopLauncher {
  const pending = new Set<ActiveDefaultLoop>();
  const requestPass = (loop: ActiveDefaultLoop): void => {
    if (loop.stopped) return;
    if (!loop.context.isIdle()) {
      pending.add(loop);
      return;
    }
    pending.delete(loop);
    try {
      pi.sendUserMessage(loop.prompt);
    } catch (error) {
      loop.context.ui.notify(
        `Default loop pass could not start: ${error instanceof Error ? error.message : String(error)}`,
        NOTIFY_WARNING_LEVEL,
      );
    }
  };
  const register = (ctx: ExtensionContext, launchers: DoomLoopLaunchersService, cron: boolean) =>
    launchers.register({
      id: cron ? 'doompi.cron' : 'doompi.default',
      source: PACKAGE_SOURCE,
      label: cron ? 'Cron loop' : 'Default loop',
      description: cron
        ? 'Run a prompt on a five-field cron schedule.'
        : 'Run your own prompt in this session on an interval',
      inputSchema: { ...(cron ? CronLoopSchema : IntervalLoopSchema) },
      async launch(request) {
        const prepared = await prepareLoop(ctx.ui, request, cron);
        if (!prepared || request.signal.aborted) return undefined;
        const loop: ActiveDefaultLoop = { prompt: prepared.prompt, context: ctx, stopped: false };
        let stopTimer: () => void;
        let schedule: string;
        if ('cron' in prepared) {
          const job = new Cron(prepared.cron, { timezone: prepared.timezone, unref: true }, () => requestPass(loop));
          if (job.nextRun() === null) {
            job.stop();
            throw new Error('Cron expression has no future run.');
          }
          stopTimer = () => {
            job.stop();
          };
          schedule = `${prepared.cron} (${prepared.timezone})`;
        } else {
          const timer = setInterval(() => requestPass(loop), prepared.intervalSeconds * MILLISECONDS_PER_SECOND);
          timer.unref?.();
          stopTimer = () => clearInterval(timer);
          schedule = `every ${prepared.intervalSeconds}s`;
          requestPass(loop);
        }
        return {
          instanceId: request.instanceId,
          label: cron ? 'Cron loop' : 'Default loop',
          detail: `${schedule} · ${promptPreview(loop.prompt)}`,
          stop() {
            if (loop.stopped) return;
            loop.stopped = true;
            stopTimer();
            pending.delete(loop);
          },
        };
      },
    });
  return {
    onAgentSettled() {
      const next = pending.values().next().value;
      if (next) requestPass(next);
    },
    register: (ctx, launchers) => register(ctx, launchers, false),
    registerCron: (ctx, launchers) => register(ctx, launchers, true),
  };
}

import type {
  DoomLoopLaunchersService,
  LoopLauncherRegistration,
  StoppableLoop,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { NOTIFY_WARNING_LEVEL, PACKAGE_SOURCE } from './loopConstants.ts';

const DEFAULT_LAUNCHER_ID = 'doompi.default';
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 3600;
const MILLISECONDS_PER_SECOND = 1000;
const PROMPT_PREVIEW_LENGTH = 80;

interface PreparedDefaultLoop {
  readonly prompt: string;
  readonly intervalSeconds: number;
}

interface ActiveDefaultLoop extends PreparedDefaultLoop {
  readonly context: ExtensionContext;
  timer?: ReturnType<typeof setInterval>;
  stopped: boolean;
}

export interface DefaultLoopLauncher {
  register(ctx: ExtensionContext, launchers: DoomLoopLaunchersService): LoopLauncherRegistration;
}

function intervalError(raw: string): string | undefined {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds)) return `Interval must be a whole number of seconds, got ${raw}.`;
  if (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    return `Interval must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`;
  }
  return undefined;
}

async function prepareDefaultLoop(
  ui: ExtensionUIContext,
  signal: AbortSignal,
): Promise<PreparedDefaultLoop | undefined> {
  const prompt = (await ui.editor('Loop prompt', ''))?.trim();
  if (!prompt || signal.aborted) return undefined;

  const rawInterval = await ui.input('Loop interval in seconds', `Default: ${DEFAULT_INTERVAL_SECONDS}s`);
  if (rawInterval === undefined || signal.aborted) return undefined;
  const normalizedInterval = rawInterval.trim() || String(DEFAULT_INTERVAL_SECONDS);
  const error = intervalError(normalizedInterval);
  if (error) {
    ui.notify(error, NOTIFY_WARNING_LEVEL);
    return undefined;
  }

  return { prompt, intervalSeconds: Number(normalizedInterval) };
}

function promptPreview(prompt: string): string {
  const oneLine = prompt.replaceAll(/\s+/gu, ' ').trim();
  return oneLine.length > PROMPT_PREVIEW_LENGTH ? `${oneLine.slice(0, PROMPT_PREVIEW_LENGTH - 1)}…` : oneLine;
}

export function createDefaultLoopLauncher(pi: ExtensionAPI): DefaultLoopLauncher {
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

  pi.on('agent_settled', () => {
    const next = pending.values().next().value;
    if (next) requestPass(next);
  });

  return {
    register(ctx, launchers) {
      return launchers.register({
        id: DEFAULT_LAUNCHER_ID,
        source: PACKAGE_SOURCE,
        label: 'Default loop',
        description: 'Run your own prompt in this session on an interval',
        async launch({ instanceId, signal }) {
          const prepared = await prepareDefaultLoop(ctx.ui, signal);
          if (!prepared || signal.aborted) return undefined;

          const loop: ActiveDefaultLoop = { ...prepared, context: ctx, stopped: false };
          loop.timer = setInterval(() => requestPass(loop), loop.intervalSeconds * MILLISECONDS_PER_SECOND);
          loop.timer.unref?.();
          requestPass(loop);

          const handle: StoppableLoop = {
            instanceId,
            label: 'Default loop',
            detail: `every ${loop.intervalSeconds}s · ${promptPreview(loop.prompt)}`,
            stop() {
              if (loop.stopped) return;
              loop.stopped = true;
              if (loop.timer) clearInterval(loop.timer);
              loop.timer = undefined;
              pending.delete(loop);
            },
          };
          return handle;
        },
      });
    },
  };
}

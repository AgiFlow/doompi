import fs from 'node:fs';
import path from 'node:path';
import { parseRelaunchHandoff, type RelaunchHandoff } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import type { AgentLauncher, AgentProcess, AgentProcessOptions, SessionFrame } from '../../types/server/session.ts';
import { spawnAgentProcess } from './agentProcess.ts';
import { observe, type ServerTelemetry } from './serverTelemetry.ts';

/** How long a relaunching agent may take to flush and exit before it is killed. */
const GRACEFUL_EXIT_TIMEOUT_MS = 15_000;
/** Persistent markers remain authoritative when native watch events are missed. */
const RELAUNCH_POLL_INTERVAL_MS = 100;
/** Startup frames retained for every server-side consumer of this agent generation. */
const EARLY_FRAME_LIMIT = 512;

export interface AgentSupervisorOptions {
  /** Composes and resolves what to spawn, per major mode. */
  launcher: AgentLauncher;
  /** File the agent writes to request a relaunch; consumed on agent exit. */
  relaunchFile: string;
  telemetry?: ServerTelemetry;
  onNotice?: (message: string) => void;
  /** Test seam for the underlying process spawner. */
  spawn?: typeof spawnAgentProcess;
  /** Test seam for the graceful-exit escalation timeout. */
  gracefulExitTimeoutMs?: number;
}

/**
 * Supervises the agent across major-mode relaunches behind one stable
 * AgentProcess.
 *
 * A launcher-class session cannot recompose its extension closure in place, so
 * a mode switch journals its target and writes the relaunch file once the
 * session is idle. Pi's rpc mode shuts down gracefully when its input ends, so
 * this supervisor watches for the file, ends the agent's input, and respawns
 * it with the recorded major mode when it exits: the socket, registry record,
 * and session id all stay, and the replacement resumes the same Pi session. An
 * exit without the file is a real exit and settles `exited` as before.
 */
export async function superviseAgentRelaunches(options: AgentSupervisorOptions): Promise<AgentProcess> {
  const spawn = options.spawn ?? spawnAgentProcess;
  const listeners: Array<(frame: SessionFrame) => void> = [];
  const earlyFrames: SessionFrame[] = [];
  let stopping = false;
  let current: AgentProcess | undefined;
  let endRequested = false;
  let escalation: NodeJS.Timeout | undefined;
  let generation = 0;

  // A file left behind by a crashed run must not relaunch this one.
  fs.rmSync(options.relaunchFile, { force: true });

  const takeHandoff = (): RelaunchHandoff | undefined => {
    let text: string;
    try {
      text = fs.readFileSync(options.relaunchFile, 'utf8');
    } catch {
      return undefined;
    }
    fs.rmSync(options.relaunchFile, { force: true });
    const handoff = parseRelaunchHandoff(text);
    if (!handoff) options.onNotice?.('ignored a malformed relaunch request');
    return handoff;
  };

  // The agent writes the file only when idle, so reacting immediately is safe.
  // Ending its input asks Pi's rpc mode for a graceful, flushed exit; the
  // relaunch itself happens in the exit handler below.
  const beginGracefulEnd = (): void => {
    if (!current || endRequested || stopping || !fs.existsSync(options.relaunchFile)) return;
    endRequested = true;
    current?.endInput();
    escalation = setTimeout(() => {
      options.onNotice?.('the agent ignored the relaunch request; killing it');
      current?.stop();
    }, options.gracefulExitTimeoutMs ?? GRACEFUL_EXIT_TIMEOUT_MS);
  };

  let watcher: fs.FSWatcher | undefined;
  let poller: NodeJS.Timeout | undefined;
  let settlePendingRelaunch: (() => void) | undefined;

  const settle = (): void => {
    if (escalation) clearTimeout(escalation);
    escalation = undefined;
    watcher?.close();
    watcher = undefined;
    if (poller) clearInterval(poller);
    poller = undefined;
  };

  // Resolved before the loop so a composition failure fails the server start
  // rather than surfacing as an agent that never came up.
  const first = await options.launcher.resolve();
  const firstAgent = spawn(first);

  const exited = new Promise<number>((resolve) => {
    const attach = (agent: AgentProcess): void => {
      current = agent;
      endRequested = false;
      earlyFrames.length = 0;
      generation += 1;
      const attachedGeneration = generation;
      if (options.telemetry)
        observe(
          options.telemetry.recordEvent('doompi_server.agent.spawned', { generation: attachedGeneration }),
          options.onNotice,
        );
      agent.onFrame((frame) => {
        if (listeners.length === 0) {
          if (earlyFrames.length === EARLY_FRAME_LIMIT) earlyFrames.shift();
          earlyFrames.push(frame);
          return;
        }
        for (const listener of listeners) listener(frame);
      });
      void agent.exited.then(async (code) => {
        if (options.telemetry)
          observe(
            options.telemetry.recordEvent('doompi_server.agent.exited', {
              generation: attachedGeneration,
              exit_code: code,
            }),
            options.onNotice,
          );
        current = undefined;
        if (escalation) clearTimeout(escalation);
        escalation = undefined;
        const handoff = stopping ? undefined : takeHandoff();
        if (!handoff) {
          settle();
          resolve(code);
          return;
        }
        options.onNotice?.(`relaunching the agent with major mode ${handoff.majorMode}`);
        let next: AgentProcessOptions;
        settlePendingRelaunch = () => resolve(code);
        try {
          next = await options.launcher.resolve(handoff.majorMode);
          if (stopping) {
            resolve(code);
            return;
          }
          attach(spawn(next));
        } catch (error) {
          // Composition or spawning failed. Nothing usable remains to relaunch.
          const detail = error instanceof Error ? error.message : String(error);
          options.onNotice?.(`could not relaunch major mode ${handoff.majorMode}: ${detail}`);
          settle();
          resolve(code);
        } finally {
          settlePendingRelaunch = undefined;
        }
      });
    };
    attach(firstAgent);
    // Do not allocate monitoring until initial composition and attachment succeed.
    const watchFailed = (): void => {
      watcher?.close();
      watcher = undefined;
      options.onNotice?.('watching the relaunch request file failed; polling remains active');
    };
    try {
      const directory = path.dirname(options.relaunchFile);
      const basename = path.basename(options.relaunchFile);
      watcher = fs.watch(directory, (_event, filename) => {
        if (filename === null || filename === basename) beginGracefulEnd();
      });
      watcher.on('error', watchFailed);
    } catch {
      watchFailed();
    }
    poller = setInterval(beginGracefulEnd, RELAUNCH_POLL_INTERVAL_MS);
    poller.unref();
  });

  return {
    send(frame) {
      current?.send(frame);
    },
    onFrame(listener) {
      listeners.push(listener);
      for (const frame of earlyFrames) listener(frame);
    },
    exited,
    endInput() {
      current?.endInput();
    },
    stop() {
      stopping = true;
      settle();
      current?.stop();
      settlePendingRelaunch?.();
    },
  };
}

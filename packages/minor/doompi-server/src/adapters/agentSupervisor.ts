import fs from 'node:fs';
import path from 'node:path';
import { parseRelaunchHandoff, type RelaunchHandoff } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { relaunchAgentArgs } from '../services/serveOptions.ts';
import type { AgentProcess, SessionFrame } from '../types/session.ts';
import { spawnAgentProcess } from './agentProcess.ts';

/** How long a relaunching agent may take to flush and exit before it is killed. */
const GRACEFUL_EXIT_TIMEOUT_MS = 15_000;

export interface AgentSupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** File the agent writes to request a relaunch; consumed on agent exit. */
  relaunchFile: string;
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
export function superviseAgentRelaunches(options: AgentSupervisorOptions): AgentProcess {
  const spawn = options.spawn ?? spawnAgentProcess;
  const listeners: Array<(frame: SessionFrame) => void> = [];
  let args = [...options.args];
  let stopping = false;
  let current: AgentProcess | undefined;
  let endRequested = false;
  let escalation: NodeJS.Timeout | undefined;

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
    if (endRequested || stopping || !fs.existsSync(options.relaunchFile)) return;
    endRequested = true;
    current?.endInput();
    escalation = setTimeout(() => {
      options.onNotice?.('the agent ignored the relaunch request; killing it');
      current?.stop();
    }, options.gracefulExitTimeoutMs ?? GRACEFUL_EXIT_TIMEOUT_MS);
  };

  let watcher: fs.FSWatcher | undefined;
  try {
    const directory = path.dirname(options.relaunchFile);
    const basename = path.basename(options.relaunchFile);
    watcher = fs.watch(directory, (_event, filename) => {
      if (filename === null || filename === basename) beginGracefulEnd();
    });
  } catch {
    options.onNotice?.('relaunch requests are handled on agent exit only; watching the request file failed');
  }

  const settle = (): void => {
    if (escalation) clearTimeout(escalation);
    escalation = undefined;
    watcher?.close();
  };

  const exited = new Promise<number>((resolve) => {
    const attach = (agent: AgentProcess): void => {
      current = agent;
      endRequested = false;
      agent.onFrame((frame) => {
        for (const listener of listeners) listener(frame);
      });
      void agent.exited.then((code) => {
        if (escalation) clearTimeout(escalation);
        escalation = undefined;
        const handoff = stopping ? undefined : takeHandoff();
        if (!handoff) {
          settle();
          resolve(code);
          return;
        }
        args = relaunchAgentArgs(args, handoff.majorMode);
        options.onNotice?.(`relaunching the agent with major mode ${handoff.majorMode}`);
        attach(spawn({ command: options.command, args, cwd: options.cwd, env: options.env }));
      });
    };
    attach(spawn({ command: options.command, args, cwd: options.cwd, env: options.env }));
  });

  return {
    send(frame) {
      current?.send(frame);
    },
    onFrame(listener) {
      listeners.push(listener);
    },
    exited,
    endInput() {
      current?.endInput();
    },
    stop() {
      stopping = true;
      settle();
      current?.stop();
    },
  };
}

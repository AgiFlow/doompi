import { spawn } from 'node:child_process';
import { createFrameDecoder, encodeFrame } from '../services/sessionFraming.ts';
import type { AgentProcess, AgentProcessOptions, SessionFrame } from '../types/session.ts';

const PIPE_STDIO = 'pipe';
const INHERIT_STDIO = 'inherit';

/**
 * Supervises one headless agent, speaking its newline-delimited JSON protocol.
 *
 * The agent's stderr is inherited rather than captured: diagnostics belong to
 * whoever started the server, not to an attached client that may not exist
 * when the agent complains.
 */
export function spawnAgentProcess(options: AgentProcessOptions): AgentProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [PIPE_STDIO, PIPE_STDIO, INHERIT_STDIO],
  });
  if (!child.stdin || !child.stdout) throw new Error('The agent process exposed no stdio to supervise.');

  const listeners: Array<(frame: SessionFrame) => void> = [];
  const decode = createFrameDecoder();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const frame of decode(chunk)) {
      for (const listener of listeners) listener(frame);
    }
  });

  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

  return {
    send(frame) {
      child.stdin?.write(encodeFrame(frame));
    },
    onFrame(listener) {
      listeners.push(listener);
    },
    exited,
    stop() {
      child.stdin?.end();
      child.kill();
    },
  };
}

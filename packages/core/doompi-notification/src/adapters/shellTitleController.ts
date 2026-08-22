import { Worker } from 'node:worker_threads';
import type { ShellTitleCommand, ShellTitleController, WriteTitle } from '../types/notifications.ts';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TITLE_FRAME_INTERVAL_MS = 80;
/**
 * The animator runs off the main thread so a busy agent turn cannot stall the
 * spinner. It is an inline eval source rather than a shipped file because the
 * package is bundled per entry, and a separate worker module would have to be
 * located on disk at runtime.
 */
const TITLE_WORKER_SOURCE = `
const { writeSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
let frameIndex = 0;
let timer;
const writeTitle = (title) => writeSync(1, '\\u001b]0;' + title + '\\u0007');
const stop = () => {
  if (timer) clearInterval(timer);
  timer = undefined;
  frameIndex = 0;
};
parentPort.on('message', (command) => {
  stop();
  if (command.action === 'start') {
    const render = () => {
      writeTitle(workerData.frames[frameIndex % workerData.frames.length] + ' ' + command.title);
      frameIndex += 1;
    };
    render();
    timer = setInterval(render, workerData.intervalMs);
    return;
  }
  writeTitle(command.title);
  if (command.action === 'dispose') parentPort.close();
});
`;

/** Animates on the main thread, for hosts where a worker could not be started. */
export function createMainThreadTitleController(): ShellTitleController {
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopAnimation = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    frameIndex = 0;
  };

  return {
    set(title, write) {
      stopAnimation();
      write(title);
    },
    start(title, write) {
      stopAnimation();
      const render = () => {
        write(`${BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length]} ${title}`);
        frameIndex += 1;
      };
      render();
      timer = setInterval(render, TITLE_FRAME_INTERVAL_MS);
    },
    stop(title, write) {
      stopAnimation();
      write(title);
    },
    dispose(title, write) {
      stopAnimation();
      write(title);
    },
  };
}

/**
 * Animates from a worker thread, replaying the last command on the main thread
 * if the worker never started, failed, or exited under us. The worker is
 * unreferenced so a pending frame never holds the process open.
 */
export function createWorkerTitleController(): ShellTitleController {
  const fallback = createMainThreadTitleController();
  let lastCommand: ShellTitleCommand | undefined;
  let lastWrite: WriteTitle | undefined;
  let worker: Worker | undefined;

  const fallBack = () => {
    worker = undefined;
    if (!lastCommand || !lastWrite) return;
    fallback[lastCommand.action](lastCommand.title, lastWrite);
  };

  try {
    const titleWorker = new Worker(TITLE_WORKER_SOURCE, {
      eval: true,
      workerData: { frames: BRAILLE_FRAMES, intervalMs: TITLE_FRAME_INTERVAL_MS },
    });
    titleWorker.unref();
    titleWorker.once('error', fallBack);
    titleWorker.once('exit', (code) => {
      if (code !== 0 && worker === titleWorker) fallBack();
    });
    worker = titleWorker;
  } catch {
    // Workers are unavailable on this host, which the main-thread animator covers.
    worker = undefined;
  }

  const dispatch = (command: ShellTitleCommand, write: WriteTitle) => {
    lastCommand = command;
    lastWrite = write;
    if (!worker) {
      fallback[command.action](command.title, write);
      return;
    }
    try {
      worker.postMessage(command);
    } catch {
      // The worker closed between the last frame and this command.
      fallBack();
    }
  };

  return {
    set: (title, write) => dispatch({ action: 'set', title }, write),
    start: (title, write) => dispatch({ action: 'start', title }, write),
    stop: (title, write) => dispatch({ action: 'stop', title }, write),
    dispose: (title, write) => dispatch({ action: 'dispose', title }, write),
  };
}

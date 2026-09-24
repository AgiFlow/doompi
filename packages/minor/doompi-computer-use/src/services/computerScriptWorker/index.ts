/** Source for an isolated child process. Restricted modules execute in QuickJS, not in Node's realm. */
export const COMPUTER_SCRIPT_WORKER_SOURCE = String.raw`
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

let nextRequestId = 0;
let started = false;
const pending = new Map();
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
const send = (message) => {
  if (process.connected) process.send(message, () => {});
};
const call = (operation, payload) => new Promise((resolve, reject) => {
  if (controller.signal.aborted) return reject(new Error('Computer script was cancelled.'));
  if (pending.size >= 64) return reject(new Error('Too many outstanding program operations.'));
  const id = String(++nextRequestId);
  pending.set(id, { resolve, reject });
  send({ type: 'program', id, operation, payload });
});

async function restricted(message) {
  const { getQuickJS } = await import(pathToFileURL(message.quickjsPath).href);
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + message.timeoutMs;
  runtime.setInterruptHandler(() => controller.signal.aborted || Date.now() >= deadline);
  const root = realpathSync(message.scriptRoot);
  const sources = new Map();
  let sourceBytes = 0;
  let moduleFailure;
  const modulePath = (candidate) => {
    const filename = realpathSync(candidate);
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Computer helper escapes the admitted script root.');
    }
    if (!/\.(ts|js|mjs)$/.test(filename)) throw new Error('Computer helpers must be JavaScript or erasable TypeScript.');
    return filename;
  };
  const entry = modulePath(message.scriptPath);
  runtime.setModuleLoader((filename) => {
    // Preserve a rejected normalization even if the engine subsequently asks to load an empty name.
    if (moduleFailure) throw moduleFailure;
    if (sources.has(filename)) return sources.get(filename);
    if (sources.size >= 32 || statSync(filename).size > 256 * 1024) throw new Error('Computer script module limit exceeded.');
    const source = readFileSync(filename, 'utf8');
    sourceBytes += Buffer.byteLength(source);
    if (sourceBytes > 512 * 1024) throw new Error('Computer script source limit exceeded.');
    const compiled = filename.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
    sources.set(filename, compiled);
    return compiled;
  }, (base, name) => {
    try {
      if (name === '__entry__') return entry;
      if (!name.startsWith('./') && !name.startsWith('../')) {
        throw new Error('Restricted computer functions cannot import host or package modules.');
      }
      return modulePath(path.resolve(path.dirname(base), name));
    } catch (error) {
      moduleFailure = error;
      throw error;
    }
  });
  const vm = runtime.newContext();
  let disposed = false;
  const deferreds = new Set();
  const pump = () => {
    if (disposed) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      const detail = vm.dump(jobs.error);
      jobs.error.dispose();
      throw new Error(detail?.message ?? String(detail));
    }
  };
  const set = (name, value) => {
    vm.setProp(vm.global, name, value);
    value.dispose();
  };
  set('__input', vm.newString(JSON.stringify(message.input)));
  set('__aborted', vm.newFunction('__aborted', () => controller.signal.aborted ? vm.true : vm.false));
  set('__log', vm.newFunction('__log', (level, text) => {
    send({ type: 'log', level: vm.getString(level), message: vm.getString(text) });
  }));
  set('__call', vm.newFunction('__call', (operationHandle, payloadHandle) => {
    const operation = vm.getString(operationHandle);
    const serialized = vm.getString(payloadHandle);
    if (serialized.length > message.maxOutputBytes) throw new Error('Computer action exceeds the size limit.');
    if (operation !== 'observe' && operation !== 'act') throw new Error('Unsupported program operation.');
    const deferred = vm.newPromise();
    deferreds.add(deferred);
    call(operation, JSON.parse(serialized)).then((value) => {
      if (disposed) return;
      const handle = vm.newString(JSON.stringify(value));
      deferred.resolve(handle);
      handle.dispose();
    }, (error) => {
      if (disposed) return;
      const handle = vm.newError(error.message);
      deferred.reject(handle);
      handle.dispose();
    }).then(() => {
      if (disposed) return;
      deferred.dispose();
      deferreds.delete(deferred);
      pump();
    }).catch((error) => send({ type: 'failed', error: error.message }));
    return deferred.handle.dup();
  }));
  let evaluation;
  try {
    evaluation = vm.unwrapResult(vm.evalCode(
      'import { run } from "__entry__";\n' +
      'const invoke = __call; const log = __log; const isAborted = __aborted;\n' +
      'const program = Object.freeze({\n' +
      ' observe: async (options = {}) => JSON.parse(await invoke("observe", JSON.stringify(options))),\n' +
      ' act: async (action) => JSON.parse(await invoke("act", JSON.stringify(action)))\n' +
      '});\n' +
      'const logger = Object.freeze(Object.fromEntries(["debug","info","warn","error"].map(level => [level, value => log(level, String(value))])));\n' +
      'const signal = Object.freeze({ get aborted() { return isAborted(); }, throwIfAborted() { if (isAborted()) throw new Error("Computer script was cancelled."); } });\n' +
      'const result = await run({ context: { program }, input: JSON.parse(__input), logger, signal });\n' +
      'globalThis.__result = result === undefined ? undefined : JSON.stringify(result);',
      path.join(root, '__computer_entry__.mjs'), { type: 'module' },
    ));
    const completion = vm.resolvePromise(evaluation);
    pump();
    const completed = vm.unwrapResult(await completion);
    completed.dispose();
    const result = vm.getProp(vm.global, '__result');
    const resultJson = vm.dump(result);
    result.dispose();
    return resultJson;
  } finally {
    disposed = true;
    for (const deferred of deferreds) deferred.dispose();
    evaluation?.dispose();
    vm.dispose();
    runtime.dispose();
  }
}

process.on('message', async (message) => {
  if (message?.type === 'response') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
    return;
  }
  if (message?.type !== 'start' || started) return;
  started = true;
  try {
    let resultJson;
    if (message.trusted) {
      const loaded = await import(pathToFileURL(message.scriptPath).href);
      if (typeof loaded.run !== 'function') throw new Error('Computer script must export a named run function.');
      const program = {
        observe: (options = {}) => call('observe', options),
        act: (action) => call('act', action),
      };
      const logger = Object.fromEntries(['debug','info','warn','error'].map(level => [level, value => {
        send({ type: 'log', level, message: String(value) });
      }]));
      const result = await loaded.run({ context: { program }, input: message.input, logger, signal: controller.signal });
      resultJson = result === undefined ? undefined : JSON.stringify(result);
    } else {
      resultJson = await restricted(message);
    }
    if (typeof resultJson === 'string' && Buffer.byteLength(resultJson) > message.maxOutputBytes) {
      throw new Error('Computer script result exceeded the size limit.');
    }
    send({ type: 'complete', resultJson });
  } catch (error) {
    send({ type: 'failed', error: String(error?.message ?? error).slice(0, 1024) });
  }
});
`;

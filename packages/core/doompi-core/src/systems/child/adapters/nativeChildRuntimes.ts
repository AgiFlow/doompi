import path from 'node:path';

import { createAgentSessionRuntime, type AgentSessionRuntime } from '../../../pi/piSessionRuntime';
import type { DirectHarnessRuntime } from '../../../types/server/directHarnessRuntime';

// Discovery is process-local. Callers must first resolve the child through its owning hub session.
const runtimes = new Map<string, AgentSessionRuntime>();

export function registerNativeChild(file: string, runtime: DirectHarnessRuntime): () => void {
  const key = path.resolve(file);
  const service = createAgentSessionRuntime({
    runtime,
    sessionId: runtime.sessionId,
    sessionName: runtime.sessionId,
    cwd: '',
  });
  runtimes.set(key, service);
  return () => {
    if (runtimes.get(key) === service) runtimes.delete(key);
    void service.dispose();
  };
}

export function nativeChildRuntime(file: string): AgentSessionRuntime | undefined {
  return runtimes.get(path.resolve(file));
}

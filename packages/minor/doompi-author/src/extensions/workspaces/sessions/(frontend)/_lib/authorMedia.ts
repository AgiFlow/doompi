import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

/**
 * Native media elements cannot perform the remote session's encrypted HTTP exchange.
 *
 * `source` addresses the host's own session file route, which the route table
 * declares as `file` with `host: true`; this package serves no bytes of its
 * own. The transport stays raw because what comes back is a blob, and a call
 * through the generated client reads the body as JSON to report a refusal.
 */
export async function loadAuthorMedia(source: string, signal: AbortSignal): Promise<{ url: string; dispose(): void }> {
  const response = await sealedTransport.fetch(source, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Author media could not be loaded (${response.status}).`);
  const blob = await response.blob();
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  let disposed = false;
  return {
    url,
    dispose() {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(url);
    },
  };
}

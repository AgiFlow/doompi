import { Server, type RoutedSessionAttachment, type ServerHost } from '@earendil-works/pi-server';
import type { ByteTransportFactory } from '@earendil-works/pi-client';
import type { WSEvents, WSContext } from 'hono/ws';
import WebSocket from 'ws';
import { FEDERATION_MAX_BODY_BYTES, FEDERATION_PROTOCOL_ROUTE } from '../services/federationPolicy.ts';
import type { FederationPeer } from '../types/agentCatalog.ts';
import type { SessionRecord } from '../types/registry.ts';
import type { FederationStore } from './federationStore.ts';
import {
  connectFederationPeer,
  type FederationTransport,
  type FederationProtocolAdmission,
} from './federationTransport.ts';
import { createPiHubService, type HubSessionMetadata } from './piHubService.ts';
import { createPiWebSocketListener } from './piWebSocketListener.ts';

const MAX_SOCKETS = 64;
const MAX_QUEUED_FRAMES = 32;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const AUTH_CHECK_INTERVAL_MS = 1000;
const MAX_PLAIN_CHUNK = FEDERATION_MAX_BODY_BYTES / 2;
const READY = '{"type":"ready"}';

function writeSocket(socket: WebSocket, frame: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + Buffer.byteLength(frame) > MAX_QUEUED_FRAMES * FEDERATION_MAX_BODY_BYTES
  )
    return Promise.reject(new Error('Federation socket write queue unavailable.'));
  return new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      if (error) reject(error);
      else resolve();
    };
    const cancelled = () => done(new Error('Federation socket closed during write.'));
    const timer = setTimeout(() => done(new Error('Federation socket write timed out.')), 15_000);
    timer.unref();
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      socket.send(frame, done);
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** A peer gets only the local sessions explicitly granted to its pinned identity. */
export function createFederationHubService(
  admission: FederationProtocolAdmission,
  records: () => readonly SessionRecord[],
  onNotice: (message: string) => void,
): ServerHost<HubSessionMetadata> {
  const host = createPiHubService({
    records: () => records().filter((record) => admission.peer.agentIds.includes(record.id)),
    onNotice,
  });
  return {
    serverServices: host.serverServices,
    async resolveSession(id, context) {
      admission.assertAgent(id);
      const result = await host.resolveSession(id, context);
      admission.assertAgent(id);
      return result;
    },
    async openSession(metadata, context) {
      admission.assertAgent(metadata.id);
      const handle = await host.openSession(metadata, context);
      try {
        admission.assertAgent(metadata.id);
      } catch (error) {
        await handle.close(context);
        throw error;
      }
      return {
        terminated: handle.terminated,
        close: (closeContext) => handle.close(closeContext),
        async attachClient(attachContext): Promise<RoutedSessionAttachment> {
          admission.assertAgent(metadata.id);
          const attachment = await handle.attachClient(attachContext);
          try {
            admission.assertAgent(metadata.id);
          } catch (error) {
            await attachment.release(attachContext);
            throw error;
          }
          return {
            release: (releaseContext) => attachment.release(releaseContext),
            async invokeService(call, publish, callContext) {
              admission.assertAgent(metadata.id);
              const result = await attachment.invokeService(
                call,
                (id, update, publishContext) => {
                  admission.assertAgent(metadata.id);
                  return publish(id, update, publishContext);
                },
                callContext,
              );
              admission.assertAgent(metadata.id);
              return result;
            },
          };
        },
      };
    },
  };
}

/** Separate peer socket: never pass these credentials to the human-device listeners. */
export function createFederationProtocol(options: {
  transport: FederationTransport;
  store: FederationStore;
  records(): readonly SessionRecord[];
  onNotice(message: string): void;
}) {
  const sockets = new Set<() => void>();
  let disposed = false;
  return {
    close() {
      disposed = true;
      for (const close of sockets) close();
    },
    events(): WSEvents<WebSocket> {
      let socket: WSContext<WebSocket> | undefined;
      const writes = new AbortController();
      let admission: FederationProtocolAdmission | undefined;
      let server: Server | undefined;
      let handler: ReturnType<ReturnType<typeof createPiWebSocketListener>['accept']>;
      let closed = false;
      let pending = 0;
      let settled = Promise.resolve();
      let sending = Promise.resolve();
      let queuedFrames = 0;
      let watchdog: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const notify = (message: string): void => {
        try {
          options.onNotice(message);
        } catch {
          // Diagnostics must not prevent terminal cleanup.
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        writes.abort();
        clearTimeout(deadline);
        clearInterval(watchdog);
        sockets.delete(close);
        try {
          handler?.onClose();
        } catch (error) {
          notify(`federation protocol close: ${String(error)}`);
        }
        try {
          admission?.stream.close();
        } catch (error) {
          notify(`federation stream close: ${String(error)}`);
        }
        try {
          if (socket?.raw) socket.raw.terminate();
          else socket?.close(1000, 'Federation connection closed');
        } catch (error) {
          notify(`federation socket close: ${String(error)}`);
        }
        if (server) void server.close().catch((error: unknown) => notify(`federation cleanup: ${String(error)}`));
      };
      const fail = (error: unknown) => {
        if (closed) return;
        notify(`federation protocol: ${String(error)}`);
        close();
      };
      const enqueueOutbound = (frameCount: number, operation: () => Promise<void>): Promise<void> => {
        if (closed || !socket) return Promise.reject(new Error('Federation socket closed.'));
        if (frameCount < 1 || queuedFrames + frameCount > MAX_QUEUED_FRAMES)
          return Promise.reject(new Error('Federation socket send queue exhausted.'));
        queuedFrames += frameCount;
        const next = sending
          .then(async () => {
            if (closed || !socket) throw new Error('Federation socket closed before send.');
            await operation();
          })
          .finally(() => {
            queuedFrames -= frameCount;
          });
        sending = next.catch(() => undefined);
        return next;
      };
      return {
        onOpen(_event, ws) {
          socket = ws;
          if (disposed || sockets.size >= MAX_SOCKETS) {
            close();
            return;
          }
          sockets.add(close);
          deadline = setTimeout(close, HANDSHAKE_TIMEOUT_MS);
          deadline.unref();
        },
        onMessage(event) {
          const data = event.data;
          const size =
            typeof data === 'string' ? Buffer.byteLength(data) : data instanceof Blob ? data.size : data.byteLength;
          if (closed || size > FEDERATION_MAX_BODY_BYTES || ++pending > MAX_QUEUED_FRAMES) {
            close();
            return;
          }
          settled = settled
            .then(async () => {
              if (closed) return;
              const text =
                typeof data === 'string'
                  ? data
                  : data instanceof Blob
                    ? await data.text()
                    : Buffer.from(data).toString('utf8');
              const envelope: unknown = JSON.parse(text);
              if (!admission) {
                admission = await options.transport.promote(envelope, close);
                if (closed) {
                  admission.stream.close();
                  return;
                }
                const admitted = admission;
                const listener = createPiWebSocketListener({ onError: fail });
                server = new Server(
                  createFederationHubService(admitted, () => options.records(), notify),
                  {
                    serverId: options.store.identity().hubId,
                    listeners: [listener],
                    onError: fail,
                  },
                );
                await server.start();
                if (closed) {
                  await server.close();
                  return;
                }
                await enqueueOutbound(1, async () => {
                  const current = socket;
                  if (!current) throw new Error('Federation socket closed before welcome.');
                  if (!current.raw) throw new Error('Federation socket has no native transport.');
                  await writeSocket(
                    current.raw,
                    JSON.stringify(admitted.stream.seal(new TextEncoder().encode(READY))),
                    writes.signal,
                  );
                });
                if (closed) {
                  await server.close();
                  return;
                }
                handler = listener.accept({
                  async send(bytes) {
                    const chunk = Uint8Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
                    if (chunk.byteLength === 0) return;
                    const frameCount = Math.ceil(chunk.byteLength / MAX_PLAIN_CHUNK);
                    return enqueueOutbound(frameCount, async () => {
                      const current = socket;
                      if (!current) throw new Error('Federation socket closed before send.');
                      for (let offset = 0; offset < chunk.byteLength; offset += MAX_PLAIN_CHUNK) {
                        if (!current.raw) throw new Error('Federation socket has no native transport.');
                        await writeSocket(
                          current.raw,
                          JSON.stringify(admitted.stream.seal(chunk.subarray(offset, offset + MAX_PLAIN_CHUNK))),
                          writes.signal,
                        );
                      }
                    }).catch((error: unknown) => {
                      fail(error);
                      throw error;
                    });
                  },
                  close,
                });
                clearTimeout(deadline);
                watchdog = setInterval(() => {
                  try {
                    admitted.stream.assertActive();
                  } catch (error) {
                    fail(error);
                  }
                }, AUTH_CHECK_INTERVAL_MS);
                watchdog.unref();
              } else {
                handler?.onData(admission.stream.open(envelope));
              }
            })
            .catch(fail)
            .finally(() => {
              pending -= 1;
            });
        },
        onClose: close,
        onError: fail,
      };
    },
  };
}

/** Native Node transport for the same Pi protocol used by the cockpit and local Unix bridge. */
export function createFederationClientTransport(options: {
  store: FederationStore;
  peer: FederationPeer;
}): ByteTransportFactory {
  return async (handlers) => {
    const peer = await connectFederationPeer(options);
    let promoted: Awaited<ReturnType<typeof peer.promote>>;
    try {
      promoted = await peer.promote();
    } catch (error) {
      peer.close();
      throw error;
    }
    const { hello, stream } = promoted;
    const url = new URL(FEDERATION_PROTOCOL_ROUTE, options.peer.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, {
        origin: options.peer.origin,
        followRedirects: false,
        maxPayload: FEDERATION_MAX_BODY_BYTES,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch (error) {
      peer.close();
      throw error;
    }
    const writes = new AbortController();
    let terminal = false;
    let ready = false;
    let sending = Promise.resolve();
    let queuedFrames = 0;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let rejectReady: (error: Error) => void = () => {};
    const stop = (error?: Error) => {
      if (terminal) return;
      terminal = true;
      writes.abort();
      clearTimeout(deadline);
      clearInterval(watchdog);
      try {
        stream.close();
      } catch {
        // The terminal transport callback still owns cleanup if authorization already expired.
      }
      peer.close();
      try {
        socket.terminate();
      } catch {
        // The socket may already have completed its terminal transition.
      }
      if (!ready) rejectReady(error ?? new Error('Federation socket closed before ready.'));
      else if (error) handlers.onError(error);
      else handlers.onClose();
    };
    const sendFrame = (frame: string): Promise<void> => writeSocket(socket, frame, writes.signal);
    const enqueueOutbound = (frameCount: number, operation: () => Promise<void>): Promise<void> => {
      if (terminal) return Promise.reject(new Error('Federation socket is closed.'));
      if (frameCount < 1 || queuedFrames + frameCount > MAX_QUEUED_FRAMES)
        return Promise.reject(new Error('Federation socket send queue exhausted.'));
      queuedFrames += frameCount;
      const next = sending
        .then(async () => {
          if (terminal) throw new Error('Federation socket closed before send.');
          await operation();
        })
        .finally(() => {
          queuedFrames -= frameCount;
        });
      sending = next.catch(() => undefined);
      return next;
    };
    await new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      deadline = setTimeout(() => stop(new Error('Federation protocol handshake timed out.')), HANDSHAKE_TIMEOUT_MS);
      deadline.unref();
      socket.on('open', () => {
        if (terminal) return;
        void enqueueOutbound(1, () => sendFrame(JSON.stringify(hello))).catch((error: unknown) =>
          stop(error instanceof Error ? error : new Error(String(error))),
        );
      });
      socket.on('message', (data) => {
        if (terminal) return;
        try {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
          const bytes = stream.open(JSON.parse(text));
          if (!ready) {
            if (new TextDecoder().decode(bytes) !== READY) throw new Error('Federation protocol welcome refused.');
            ready = true;
            clearTimeout(deadline);
            watchdog = setInterval(() => {
              try {
                stream.assertActive();
              } catch (error) {
                stop(error instanceof Error ? error : new Error(String(error)));
              }
            }, AUTH_CHECK_INTERVAL_MS);
            watchdog.unref();
            resolve();
          } else handlers.onData(bytes);
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on('close', () => stop());
      socket.on('error', (error) => stop(error));
    });
    return {
      async send(chunk) {
        if (terminal) throw new Error('Federation socket is closed.');
        if (chunk.byteLength === 0) return;
        const copy = new Uint8Array(chunk);
        const frameCount = Math.ceil(copy.byteLength / MAX_PLAIN_CHUNK);
        try {
          await enqueueOutbound(frameCount, async () => {
            for (let offset = 0; offset < copy.byteLength; offset += MAX_PLAIN_CHUNK) {
              stream.assertActive();
              await sendFrame(JSON.stringify(stream.seal(copy.subarray(offset, offset + MAX_PLAIN_CHUNK))));
            }
          });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          stop(failure);
          throw failure;
        }
      },
      close: () => stop(),
    };
  };
}

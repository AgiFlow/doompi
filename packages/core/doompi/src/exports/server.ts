export { spawnAgentProcess } from '../adapters/server/agentProcess.ts';
// The protocol surface, published so a client can compose the same session
// server it dials rather than reimplementing the projection behind it.
export { createAgentServerService, createAgentSessionRuntime } from '../adapters/server/piSessionRuntime.ts';
export type {
  AgentServerServiceOptions,
  AgentSessionRuntime,
  AgentSessionRuntimeOptions,
  DoomSessionMetadata,
} from '../adapters/server/piSessionRuntime.ts';
export { serveProtocolSocket } from '../adapters/server/protocolSocket.ts';
export type { ProtocolSocket, ProtocolSocketOptions } from '../adapters/server/protocolSocket.ts';
export { createRpcTranscript } from '../services/server/rpcTranscript.ts';
export type { RpcTranscript, RpcTranscriptOptions, TranscriptReduction } from '../services/server/rpcTranscript.ts';
export { serveSessionSocket } from '../adapters/server/socketServer.ts';
export type { SessionSocket, SessionSocketOptions } from '../adapters/server/socketServer.ts';
export {
  HANDSHAKE_ERROR_TYPE,
  HANDSHAKE_OK_TYPE,
  HANDSHAKE_TYPE,
  REPLAY_TYPE,
  evaluateHandshake,
} from '../services/server/handshake.ts';
export type { HandshakeOutcome } from '../services/server/handshake.ts';
export { createDetachedBacklog, createFrameDecoder, encodeFrame } from '../services/server/sessionFraming.ts';
export type { DetachedBacklog } from '../services/server/sessionFraming.ts';
export { parseServeOptions, SERVE_USAGE } from '../services/server/serveOptions.ts';
export type { ServeOptions } from '../services/server/serveOptions.ts';
export { SESSION_RECORD_VERSION } from '../types/server/registry.ts';
export type { SessionRecord } from '../types/server/registry.ts';
export type { AgentProcess, AgentProcessFactory, AgentProcessOptions, SessionFrame } from '../types/server/session.ts';

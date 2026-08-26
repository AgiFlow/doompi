export { spawnAgentProcess } from '../adapters/agentProcess.ts';
// The protocol surface, published so a client can compose the same session
// server it dials rather than reimplementing the projection behind it.
export { createAgentServerService, createAgentSessionRuntime } from '../adapters/piSessionRuntime.ts';
export type { AgentServerServiceOptions, AgentSessionRuntimeOptions } from '../adapters/piSessionRuntime.ts';
export { serveProtocolSocket } from '../adapters/protocolSocket.ts';
export type { ProtocolSocket, ProtocolSocketOptions } from '../adapters/protocolSocket.ts';
export { createRpcTranscript } from '../services/rpcTranscript.ts';
export type { RpcTranscript, RpcTranscriptOptions, TranscriptReduction } from '../services/rpcTranscript.ts';
export { serveSessionSocket } from '../adapters/socketServer.ts';
export type { SessionSocket, SessionSocketOptions } from '../adapters/socketServer.ts';
export {
  HANDSHAKE_ERROR_TYPE,
  HANDSHAKE_OK_TYPE,
  HANDSHAKE_TYPE,
  REPLAY_TYPE,
  evaluateHandshake,
} from '../services/handshake.ts';
export type { HandshakeOutcome } from '../services/handshake.ts';
export { createDetachedBacklog, createFrameDecoder, encodeFrame } from '../services/sessionFraming.ts';
export type { DetachedBacklog } from '../services/sessionFraming.ts';
export { parseServeOptions, SERVE_USAGE } from '../services/serveOptions.ts';
export type { ServeOptions } from '../services/serveOptions.ts';
export { SESSION_RECORD_VERSION } from '../types/registry.ts';
export type { SessionRecord } from '../types/registry.ts';
export type { AgentProcess, AgentProcessFactory, AgentProcessOptions, SessionFrame } from '../types/session.ts';

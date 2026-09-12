export { createHeadlessHub } from '../server/headlessHub';
export { serveHeadlessServer } from '../server/headlessServer';
export type { HeadlessHub, HeadlessHubEvent, HeadlessHubOptions, HeadlessHubSession } from '../server/headlessHub';
export type { HeadlessServer, HeadlessServerOptions } from '../server/headlessServer';
export type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../systems/main/types/headlessSessionHost';
export type {
  HeadlessSessionManager,
  HeadlessSessionManagerCreateOptions,
} from '../systems/main/types/headlessSessionManager';
export {
  createHeadlessChildSessionService,
  createHeadlessChildSessionServiceProvider,
} from '../systems/child/adapters/headlessChildSessionService';
export {
  captureTerminalPiForkSource,
  createTerminalPiChildSessionService,
  createTerminalPiChildSessionServiceProvider,
} from '../systems/child/adapters/terminalPiChildSessionService';
export type {
  HeadlessChildSessionServiceOptions,
  HeadlessChildSessionServiceProvider,
} from '../systems/child/adapters/headlessChildSessionService';
export type {
  TerminalPiChildSessionServiceOptions,
  TerminalPiChildSessionServiceProvider,
  TerminalPiForkSourceManager,
} from '../systems/child/adapters/terminalPiChildSessionService';
// The protocol surface, published so a client can compose the same session
// server it dials rather than reimplementing the projection behind it.
export { createAgentServerService, createAgentSessionRuntime } from '../pi/piSessionRuntime';
export type {
  AgentServerServiceOptions,
  AgentSessionRuntime,
  AgentSessionRuntimeOptions,
  DoomSessionMetadata,
} from '../pi/piSessionRuntime';
export { createRpcTranscript } from '../services/rpcTranscript';
export type { RpcTranscript, RpcTranscriptOptions, TranscriptReduction } from '../services/rpcTranscript';
export type { SessionFrame } from '../types/server/session';

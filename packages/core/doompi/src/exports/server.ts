export { createHeadlessHub } from '../adapters/server/headlessHub.ts';
export { serveHeadlessServer } from '../adapters/server/headlessServer.ts';
export type {
  HeadlessHub,
  HeadlessHubEvent,
  HeadlessHubOptions,
  HeadlessHubSession,
} from '../adapters/server/headlessHub.ts';
export type { HeadlessServer, HeadlessServerOptions } from '../adapters/server/headlessServer.ts';
export type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../types/server/headlessSessionHost.ts';
export type {
  HeadlessSessionManager,
  HeadlessSessionManagerCreateOptions,
} from '../types/server/headlessSessionManager.ts';
export {
  createHeadlessChildSessionService,
  createHeadlessChildSessionServiceProvider,
} from '../adapters/server/headlessChildSessionService.ts';
export {
  captureTerminalPiForkSource,
  createTerminalPiChildSessionService,
  createTerminalPiChildSessionServiceProvider,
} from '../adapters/pi/terminalPiChildSessionService.ts';
export type {
  HeadlessChildSessionServiceOptions,
  HeadlessChildSessionServiceProvider,
} from '../adapters/server/headlessChildSessionService.ts';
export type {
  TerminalPiChildSessionServiceOptions,
  TerminalPiChildSessionServiceProvider,
  TerminalPiForkSourceManager,
} from '../adapters/pi/terminalPiChildSessionService.ts';
// The protocol surface, published so a client can compose the same session
// server it dials rather than reimplementing the projection behind it.
export { createAgentServerService, createAgentSessionRuntime } from '../adapters/server/piSessionRuntime.ts';
export type {
  AgentServerServiceOptions,
  AgentSessionRuntime,
  AgentSessionRuntimeOptions,
  DoomSessionMetadata,
} from '../adapters/server/piSessionRuntime.ts';
export { createRpcTranscript } from '../services/server/rpcTranscript.ts';
export type { RpcTranscript, RpcTranscriptOptions, TranscriptReduction } from '../services/server/rpcTranscript.ts';
export { parseServeOptions, SERVE_USAGE } from '../services/server/serveOptions.ts';
export type { ServeOptions } from '../services/server/serveOptions.ts';
export type { SessionFrame } from '../types/server/session.ts';

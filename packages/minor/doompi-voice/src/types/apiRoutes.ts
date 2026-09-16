import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import {
  VOICE_MEDIA_ROUTES,
  type VoiceMediaClientEvent,
  type VoiceMediaConnectResult,
  type VoiceMediaWake,
} from './clientMedia';
import { MANUAL_TRANSCRIPTION_ROUTE, type ManualTranscriptionResult } from './manualTranscription';
import { REALTIME_ROUTES } from './realtime';

/**
 * What `GET /status` answers: the session's voice state plus two readiness reports.
 *
 * Spelled here rather than imported from `src/schemas/apiContracts.ts`, because
 * that file is TypeBox and this one is read by the browser bundle. The contract
 * remains the authority on the wire shape; this is the same shape as types.
 */
export interface VoiceStatusView {
  state: string;
  mode: string;
  manual: string;
  muted: boolean;
  error?: string;
  media: { closed: boolean; capture: boolean; playback: boolean; realtime: boolean };
  readiness: VoiceReadinessView;
}

export interface VoiceReadinessView {
  configured: boolean;
  transcription: boolean;
  error?: string;
  engine?: string;
  mode?: string;
  correctionModel?: string;
}

/** What `POST /control` answers: the session's voice state after the action. */
export type VoiceControlView = Omit<VoiceStatusView, 'media' | 'readiness'>;

/**
 * The routes a browser calls, as data.
 *
 * No scope and no base path: the build reads both off the
 * `(backend)/api/<base-path>/` folders, so `voice-media` and `voice` each state
 * their mount once, where they create it. This package had them written out in
 * `voiceMediaClientUrl`, again in two hand-rolled dispatch tables, and again in
 * `src/schemas/apiContracts.ts`, and only the contract was ever reviewed.
 *
 * `path` reuses the route constants the server dispatches on rather than
 * restating the strings, because the dispatch is hand-rolled `url.pathname ===`
 * comparison in four services and a one-character drift there is a 404 with no
 * other symptom.
 *
 * Only the browser-reachable half is here. The `/host/` and `/hub/` namespaces
 * in the contract are broker-internal: they refuse anything without the
 * host-issued bearer token, they are called in-process or across the hub, and
 * offering them on a page's client would be offering a guaranteed 404.
 */
export default defineApiRoutes({
  /*
   * voice: the session's own control surface, and the global readiness read.
   *
   * Both mount at `voice`. The base path is the same at both scopes and the
   * host resolves which handler answers, which is why one folder name serves
   * two `(backend)/api/` trees.
   */
  status: { method: 'GET', path: '/status', response: apiResponse<VoiceStatusView>() },
  control: { method: 'POST', path: '/control', response: apiResponse<VoiceControlView>() },
  readiness: { method: 'GET', path: '/readiness', response: apiResponse<VoiceReadinessView>() },

  /* voice-media: the client half of the media protocol. */
  clientConnect: {
    method: 'POST',
    path: VOICE_MEDIA_ROUTES.clientConnect,
    response: apiResponse<VoiceMediaConnectResult>(),
  },
  clientDisconnect: { method: 'POST', path: VOICE_MEDIA_ROUTES.clientDisconnect },
  clientHeartbeat: {
    method: 'POST',
    path: VOICE_MEDIA_ROUTES.clientHeartbeat,
    response: apiResponse<VoiceMediaWake>(),
  },
  /** Answers 204 when no event is pending, so the body is optional. */
  clientEvents: {
    method: 'GET',
    path: VOICE_MEDIA_ROUTES.clientEvents,
    query: ['clientId', 'connectionId', 'after', 'wait'],
    response: apiResponse<VoiceMediaClientEvent | undefined>(),
  },
  /** PCM16 bytes in, as a Blob the sealed transport relays verbatim. */
  clientAudio: {
    method: 'POST',
    path: VOICE_MEDIA_ROUTES.clientAudio,
    query: ['clientId', 'connectionId', 'captureId'],
  },
  clientCaptureStopped: { method: 'POST', path: VOICE_MEDIA_ROUTES.clientCaptureStopped },
  /**
   * PCM16 bytes out, or a 204 carrying `x-doompi-playback-state`.
   *
   * No declared response: neither answer is JSON, and the caller reads
   * `result.response` for the bytes, the status and that header.
   */
  clientPlaybackAudio: {
    method: 'GET',
    path: VOICE_MEDIA_ROUTES.clientPlaybackAudio,
    query: ['clientId', 'connectionId', 'playbackId'],
  },
  clientPlaybackResult: { method: 'POST', path: VOICE_MEDIA_ROUTES.clientPlaybackResult },
  realtimeNegotiate: {
    method: 'POST',
    path: REALTIME_ROUTES.clientNegotiate,
    response: apiResponse<{ sdp: string }>(),
  },
  realtimeEvent: { method: 'POST', path: REALTIME_ROUTES.clientEvent },
  realtimeState: { method: 'POST', path: REALTIME_ROUTES.clientState },
  /** One complete `audio/webm` or `audio/mp4` recording, posted as a Blob. */
  manualTranscribe: {
    method: 'POST',
    path: MANUAL_TRANSCRIPTION_ROUTE,
    response: apiResponse<ManualTranscriptionResult>(),
  },
});

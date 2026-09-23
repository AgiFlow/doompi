import type { DoomApi, DoomApiHandler } from '@agimon-ai/doompi-core/packageApi';

import { deliverSessionPeerEnvelope } from '../peerInbox';
import {
  createPeerReplayGuard,
  parseSessionPeerEnvelope,
  peerSessionReference,
  readSessionPeerConfig,
  verifyPeerRequest,
} from '../peerTransport';

const MAX_BODY_BYTES = 64 * 1024;
const DELIVERY_TYPES = new Set(['doom/session-delivery/envelope', 'doom/session-delivery/ack']);

function response(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Narrow HMAC-authenticated endpoint that a trusted tunnel may forward without device authentication. */
export const peerInboxApi: DoomApi = {
  basePath: 'session-peer',
  start(context): DoomApiHandler {
    const config = context.homeDirectory === undefined ? undefined : readSessionPeerConfig(context.homeDirectory);
    const replay = context.homeDirectory === undefined ? undefined : createPeerReplayGuard(context.homeDirectory);
    return {
      async fetch(request) {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/inbox') return response(404, 'Not found.');
        if (!config) return response(503, 'Paired Session delivery is not configured.');
        const length = request.headers.get('content-length');
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES))
          return response(413, 'Request body is too large.');
        const body = await request.text();
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) return response(413, 'Request body is too large.');
        const peer = verifyPeerRequest(config, request, body);
        if (!peer) return response(401, 'Paired Session request is unauthorized.');
        if (!replay?.admit(request)) return response(409, 'Paired Session request was already received.');
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          return response(400, 'Paired Session request is malformed.');
        }
        const envelope = parseSessionPeerEnvelope(parsed);
        if (!envelope || !DELIVERY_TYPES.has(envelope.type))
          return response(400, 'Paired Session envelope is invalid.');
        if (!peer.allowedSessionIds.includes(envelope.targetSessionId))
          return response(403, 'Peer is not granted this session.');
        const state = deliverSessionPeerEnvelope(
          envelope.targetSessionId,
          peerSessionReference(peer.hostId, envelope.sourceSessionId),
          envelope.type,
          envelope.payload,
        );
        return state === undefined
          ? response(404, 'Target Session is unavailable.')
          : Response.json({ accepted: true, state }, { status: 202 });
      },
      close: () => replay?.close(),
    };
  },
};

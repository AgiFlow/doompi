import type { DoomSessionDeliveryMetadata } from '../sessionDelivery';
import type { SessionIntercomMessage } from './type';
import type {
  SessionGroupDeliveryAuthorizationOptions,
  SessionIntercom,
  SessionIntercomOptions,
  SessionIntercomSendRequest,
  SessionReportStatus,
} from './type';

const MESSAGE_KIND = 'session-message';
const REPORT_KIND = 'session-report';

function metadataFor(
  options: SessionIntercomOptions,
  request: SessionIntercomSendRequest,
  reportStatus?: SessionReportStatus,
): DoomSessionDeliveryMetadata {
  const group = options.groups.get(request.groupId);
  if (!group || !options.groups.canMessage(request.groupId, options.selfReference, request.targetReference))
    throw new Error(`Session group '${request.groupId}' does not authorize this message.`);
  return {
    sourceReference: options.selfReference,
    targetReference: request.targetReference,
    groupId: request.groupId,
    groupRevision: String(group.revision),
    ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
    ...(reportStatus === undefined ? {} : { reportStatus }),
  };
}

/** Agent-facing intercom operations. A composition may acquire this service without gaining session controls. */
export function createSessionIntercom(options: SessionIntercomOptions): SessionIntercom {
  const deliver = async (
    request: SessionIntercomSendRequest,
    kind: typeof MESSAGE_KIND | typeof REPORT_KIND,
    status?: SessionReportStatus,
  ): Promise<{ deliveryId: string }> => {
    const recipientKey = options.directory.resolveDeliveryTarget(options.selfReference, request.targetReference);
    if (!recipientKey) throw new Error(`Session '${request.targetReference}' is not discoverable.`);
    const metadata = metadataFor(options, request, status);
    return options.delivery.deliver({
      ...(request.deliveryId === undefined ? {} : { deliveryId: request.deliveryId }),
      recipientKey,
      kind,
      prompt: `[Session ${status === undefined ? 'message' : `report: ${status}`} from ${options.selfReference}] ${request.text}`,
      metadata,
    });
  };

  const intercom: SessionIntercom = {
    discover() {
      const members = new Set(
        options.groups
          .groupsFor(options.selfReference)
          .flatMap((group) => group.members)
          .filter((reference) => reference !== options.selfReference),
      );
      return options.directory.discover(options.selfReference, members);
    },
    send: (request) => deliver(request, MESSAGE_KIND),
    report: (request) => deliver(request, REPORT_KIND, request.status),
    messages() {
      return options.delivery
        .inbox()
        .filter((entry) => entry.kind === MESSAGE_KIND || entry.kind === REPORT_KIND)
        .filter((entry) => {
          const groupId = entry.metadata.groupId;
          return groupId !== undefined && options.groups.get(groupId)?.members.includes(options.selfReference) === true;
        })
        .flatMap((entry): SessionIntercomMessage[] => {
          const sourceReference = entry.metadata.sourceReference;
          const targetReference = entry.metadata.targetReference;
          const groupId = entry.metadata.groupId;
          if (!sourceReference || !targetReference || !groupId) return [];
          const reportStatus = entry.metadata.reportStatus;
          return [
            {
              deliveryId: entry.deliveryId,
              sourceReference,
              targetReference,
              groupId,
              ...(entry.metadata.correlationId === undefined ? {} : { correlationId: entry.metadata.correlationId }),
              text: entry.prompt,
              ...(reportStatus === 'done' || reportStatus === 'blocked' || reportStatus === 'failed'
                ? { reportStatus }
                : {}),
              state: entry.state,
              consumed: entry.consumed,
            },
          ];
        });
    },
    delivery(deliveryId) {
      const entry = options.delivery.outbox(deliveryId);
      const groupId = entry?.metadata.groupId;
      return entry &&
        groupId !== undefined &&
        options.groups.get(groupId)?.members.includes(options.selfReference) === true
        ? entry
        : undefined;
    },
  };
  return Object.freeze(intercom);
}

/** Builds the dynamic delivery check used before every send, retry, and recipient acceptance. */
export function createSessionGroupDeliveryAuthorizer(
  options: SessionGroupDeliveryAuthorizationOptions,
): (peerKey: string, metadata: DoomSessionDeliveryMetadata | undefined) => boolean {
  return (peerKey, metadata) => {
    const sourceReference = metadata?.sourceReference;
    const targetReference = metadata?.targetReference;
    const groupId = metadata?.groupId;
    if (sourceReference && targetReference && groupId) {
      const peerReference = options.peerReference(peerKey);
      if (!peerReference) return false;
      const directionMatches =
        (sourceReference === options.selfReference && targetReference === peerReference) ||
        (targetReference === options.selfReference && sourceReference === peerReference);
      return directionMatches && options.groups.canMessage(groupId, sourceReference, targetReference);
    }
    return options.fallback?.(peerKey, metadata) === true;
  };
}

export { DOOM_SESSION_INTERCOM_SERVICE, readSessionIntercom, requireSessionIntercom } from './type';
export type {
  SessionGroupDeliveryAuthorizationOptions,
  SessionIntercom,
  SessionIntercomMessage,
  SessionIntercomOptions,
  SessionIntercomSendRequest,
  SessionReportStatus,
} from './type';

import { defineSessionStore, type SessionChannelContribution } from '@agimon-ai/doompi-web-contracts';
import { authorChannelType, type AuthorHubMessage, type AuthorWebView } from '../types/webAuthor.ts';
import { applyAuthorHubMessage, authorBridgeView, dropAuthorViewportSession } from './authorBrowserBridge.ts';
import { dropAuthorSession } from './authorWorkspaceStore.ts';

export const author = defineSessionStore<AuthorWebView>({ activation: 'inactive', capabilityCount: 0 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAuthorHubMessage(input: unknown): AuthorHubMessage | AuthorWebView | null {
  if (!isRecord(input)) return null;
  if (
    (input.activation === 'active' || input.activation === 'inactive') &&
    Number.isSafeInteger(input.capabilityCount) &&
    (input.capabilityCount as number) >= 0
  ) {
    return input as unknown as AuthorWebView;
  }
  if (typeof input.kind !== 'string') return null;
  if (input.kind === 'rejected')
    return typeof input.reason === 'string' ? (input as unknown as AuthorHubMessage) : null;
  if (!Number.isSafeInteger(input.generation) || typeof input.ownerToken !== 'string') return null;
  if (input.kind === 'accepted') {
    return typeof input.leaseMs === 'number' &&
      (input.catalogToken === undefined || typeof input.catalogToken === 'string')
      ? (input as unknown as AuthorHubMessage)
      : null;
  }
  if (
    (input.kind === 'request' || input.kind === 'cancel') &&
    typeof input.catalogToken === 'string' &&
    typeof input.requestId === 'string'
  ) {
    if (input.kind === 'cancel') return input as unknown as AuthorHubMessage;
    return typeof input.name === 'string' && isRecord(input.arguments) ? (input as unknown as AuthorHubMessage) : null;
  }
  return null;
}

export const authorChannel: SessionChannelContribution<AuthorHubMessage | AuthorWebView> = {
  channel: authorChannelType,
  parse: parseAuthorHubMessage,
  apply(sessionId, message) {
    if ('activation' in message) {
      author.update(sessionId, () => message);
      return;
    }
    applyAuthorHubMessage(sessionId, message);
    author.update(sessionId, () => authorBridgeView(sessionId));
  },
  drop(sessionId) {
    dropAuthorViewportSession(sessionId);
    dropAuthorSession(sessionId);
    author.drop(sessionId);
  },
};

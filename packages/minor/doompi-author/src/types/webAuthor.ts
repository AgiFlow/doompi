import type { AuthorViewportCapabilityDescriptor } from './author.ts';

export const authorChannelType = 'author_webmcp';

export interface AuthorRegisterMessage {
  kind: 'register';
  generation: number;
}

export interface AuthorCatalogMessage {
  kind: 'catalog';
  generation: number;
  ownerToken: string;
  tools: AuthorViewportCapabilityDescriptor[];
}

export interface AuthorResultMessage {
  kind: 'result';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
  result: unknown;
}

export interface AuthorCancelledMessage {
  kind: 'cancelled';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
}

export type AuthorBrowserMessage =
  | AuthorRegisterMessage
  | AuthorCatalogMessage
  | AuthorResultMessage
  | AuthorCancelledMessage;

export interface AuthorAcceptedMessage {
  kind: 'accepted';
  generation: number;
  ownerToken: string;
  catalogToken?: string;
  leaseMs: number;
}

export interface AuthorRequestMessage {
  kind: 'request';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AuthorCancelMessage {
  kind: 'cancel';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
}

export interface AuthorRejectedMessage {
  kind: 'rejected';
  reason: string;
}

export type AuthorHubMessage =
  | AuthorAcceptedMessage
  | AuthorRequestMessage
  | AuthorCancelMessage
  | AuthorRejectedMessage;

export interface AuthorWebView {
  activation: 'inactive' | 'active';
  capabilityCount: number;
}

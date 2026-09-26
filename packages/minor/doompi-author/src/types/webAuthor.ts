import type { AuthorViewportCapabilityDescriptor } from './author';

export const authorChannelType = 'author_webmcp';

export interface AuthorRegisterMessage {
  alias: string;
  kind: 'register';
  generation: number;
}

export interface AuthorReleaseMessage {
  alias: string;
  kind: 'release';
  generation: number;
}
export interface AuthorCatalogMessage {
  alias: string;
  kind: 'catalog';
  generation: number;
  ownerToken: string;
  tools: AuthorViewportCapabilityDescriptor[];
}

export interface AuthorResultMessage {
  alias: string;
  kind: 'result';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
  result: unknown;
}

export interface AuthorCancelledMessage {
  alias: string;
  kind: 'cancelled';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
}

export type AuthorBrowserMessage =
  | AuthorRegisterMessage
  | AuthorReleaseMessage
  | AuthorCatalogMessage
  | AuthorResultMessage
  | AuthorCancelledMessage;

export interface AuthorAcceptedMessage {
  alias?: string;
  kind: 'accepted';
  generation: number;
  ownerToken: string;
  catalogToken?: string;
  leaseMs: number;
}

export interface AuthorRequestMessage {
  alias?: string;
  kind: 'request';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AuthorCancelMessage {
  alias?: string;
  kind: 'cancel';
  generation: number;
  ownerToken: string;
  catalogToken: string;
  requestId: string;
}

export interface AuthorRejectedMessage {
  alias?: string;
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

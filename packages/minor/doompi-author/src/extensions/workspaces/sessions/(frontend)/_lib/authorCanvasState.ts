import { Store } from '@tanstack/store';

import { authorDocumentKey } from './authorWorkspaceStore';

export const canvasAliases = new Store<Readonly<Record<string, string>>>({});
export const canvasPaths = new Store<Readonly<Record<string, string>>>({});
export const canvasFailures = new Store<Readonly<Record<string, string>>>({});

export const authorCanvasAlias = (sessionId: string, path: string): string | undefined =>
  canvasAliases.state[authorDocumentKey(sessionId, path)];

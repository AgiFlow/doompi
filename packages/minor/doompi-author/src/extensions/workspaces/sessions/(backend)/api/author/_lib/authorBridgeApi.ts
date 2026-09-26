import { Hono } from 'hono';

import { AuthorBridgeError } from '../../../../../../../models/authorBridgeState';
import { parseUseAuthorToolInput } from '../../../../../../../schemas/authorTools';
import type { AuthorCanvasRegistry } from '../../../../../../../services/authorCanvasRegistry';
import routes from '../../../../../../../types/apiRoutes';
import type { AuthorViewportCapabilityDescriptor } from '../../../../../../../types/author';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AuthorBridgeError('Invalid request.', 400);
  return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
  const result = record(value)[key];
  if (typeof result !== 'string' || result === '') throw new AuthorBridgeError(`Invalid ${key}.`, 400);
  return result;
}

function generation(value: unknown): number {
  const result = record(value).generation;
  if (!Number.isSafeInteger(result) || (result as number) < 0) throw new AuthorBridgeError('Invalid generation.', 400);
  return result as number;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return record(await request.json());
}

export function createAuthorBridgeApi(registry: AuthorCanvasRegistry): Hono {
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      { error: error instanceof Error ? error.message : String(error) },
      error instanceof AuthorBridgeError ? error.status : 500,
    ),
  );
  app.post(routes.bridgeRegister.path, async (context) => {
    const value = await body(context.req.raw);
    const alias = text(value, 'alias');
    return context.json({ ...registry.bridge(alias).register(text(value, 'bindingId'), generation(value)), alias });
  });
  app.post(routes.bridgeCatalog.path, async (context) => {
    const value = await body(context.req.raw);
    const tools = value.tools;
    if (!Array.isArray(tools)) throw new AuthorBridgeError('Invalid Author catalog.', 400);
    const alias = text(value, 'alias');
    return context.json({
      ...registry
        .bridge(alias)
        .catalog(
          text(value, 'bindingId'),
          generation(value),
          text(value, 'ownerToken'),
          tools as AuthorViewportCapabilityDescriptor[],
        ),
      alias,
    });
  });
  app.post(routes.bridgeNext.path, async (context) => {
    const value = await body(context.req.raw);
    const alias = text(value, 'alias');
    return context.json({
      ...(await registry
        .bridge(alias)
        .next(text(value, 'bindingId'), generation(value), text(value, 'ownerToken'), context.req.raw.signal)),
      alias,
    });
  });
  app.post(routes.bridgeResult.path, async (context) => {
    const value = await body(context.req.raw);
    registry
      .bridge(text(value, 'alias'))
      .result(
        text(value, 'bindingId'),
        generation(value),
        text(value, 'ownerToken'),
        text(value, 'catalogToken'),
        text(value, 'requestId'),
        value.result,
      );
    return context.json({ accepted: true });
  });
  app.post(routes.bridgeCancelled.path, async (context) => {
    const value = await body(context.req.raw);
    registry
      .bridge(text(value, 'alias'))
      .cancelled(
        text(value, 'bindingId'),
        generation(value),
        text(value, 'ownerToken'),
        text(value, 'catalogToken'),
        text(value, 'requestId'),
      );
    return context.json({ accepted: true });
  });
  app.post(routes.bridgeDisconnect.path, async (context) => {
    const value = await body(context.req.raw);
    registry.bridge(text(value, 'alias')).disconnect(text(value, 'bindingId'), generation(value));
    return context.json({ accepted: true });
  });
  app.post(routes.bridgeClose.path, async (context) => {
    const value = await body(context.req.raw);
    registry.close(text(value, 'alias'));
    return context.json({ accepted: true });
  });
  app.get(routes.bridgeDescribe.path, (context) => context.json(registry.describe(context.req.query('alias'))));
  app.post(routes.bridgeInvoke.path, async (context) => {
    const value = parseUseAuthorToolInput(await context.req.raw.json());
    return context.json(await registry.invoke(value, context.req.raw.signal));
  });
  return app;
}

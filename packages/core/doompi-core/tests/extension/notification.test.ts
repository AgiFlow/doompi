import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  createDoomNotificationEntryData,
  DOOM_NOTIFICATION_ENTRY_TYPE,
  DOOM_NOTIFICATION_ENTRY_VERSION,
  DOOM_NOTIFICATION_SERVICE,
  type DoomNotificationService,
  isDoomNotificationEntryData,
  isDoomNotificationRequest,
  MAX_DOOM_NOTIFICATION_BODY_CHARACTERS,
  normalizeDoomNotificationRequest,
  readDoomNotificationService,
  requireDoomNotificationService,
} from '../../src/exports/notification';
import * as internalNotification from '../../src/schemas/notification';
describe('Doom notification Cordis contract', () => {
  it('normalizes a bounded request into complete versioned entry data', () => {
    const request = normalizeDoomNotificationRequest({
      title: '  Build\nresult ',
      subtitle: '\tWorkspace ',
      body: '  Ready\u0000 to review.  ',
      level: 'warning',
    });
    expect(request).toEqual({
      title: 'Build result',
      subtitle: 'Workspace',
      body: 'Ready to review.',
      level: 'warning',
    });
    expect(isDoomNotificationRequest(request)).toBe(true);
    expect(createDoomNotificationEntryData(request!)).toEqual({
      version: DOOM_NOTIFICATION_ENTRY_VERSION,
      title: 'Build result',
      subtitle: 'Workspace',
      body: 'Ready to review.',
      level: 'warning',
    });
  });

  it('defaults optional entry fields and rejects malformed contract data', () => {
    const entry = createDoomNotificationEntryData({ body: 'Saved.' });
    expect(entry).toEqual({ version: 1, title: '', subtitle: '', body: 'Saved.', level: 'info' });
    expect(isDoomNotificationEntryData(entry)).toBe(true);
    expect(isDoomNotificationEntryData({ ...entry, version: 2 })).toBe(false);
    expect(isDoomNotificationRequest({ body: '', level: 'success' })).toBe(false);
    expect(normalizeDoomNotificationRequest({ body: '\u0000\u007f' })).toBeUndefined();
  });

  it('omits optional text that normalizes to empty', () => {
    expect(
      normalizeDoomNotificationRequest({
        title: '',
        subtitle: ' \n\t ',
        body: 'Saved\u007f successfully',
      }),
    ).toEqual({ body: 'Saved successfully' });
    expect(createDoomNotificationEntryData({ title: ' ', subtitle: '', body: 'Saved.' })).toEqual({
      version: 1,
      title: '',
      subtitle: '',
      body: 'Saved.',
      level: 'info',
    });
  });

  it.each([null, [], 'Saved.', {}, { body: 42 }, { body: 'Saved.', title: false }, { body: 'Saved.', subtitle: [] }])(
    'rejects malformed runtime request shape %#',
    (request) => {
      expect(normalizeDoomNotificationRequest(request)).toBeUndefined();
      expect(createDoomNotificationEntryData(request)).toBeUndefined();
    },
  );

  it('rejects unknown request fields and invalid levels instead of normalizing them away', () => {
    expect(normalizeDoomNotificationRequest({ body: 'Saved.', source: 'untyped' })).toBeUndefined();
    expect(normalizeDoomNotificationRequest({ body: 'Saved.', level: 'success' })).toBeUndefined();
    expect(createDoomNotificationEntryData({ body: 'Saved.', level: 1 })).toBeUndefined();
  });

  it('truncates body text without splitting Unicode characters', () => {
    const request = normalizeDoomNotificationRequest({ body: '🙂'.repeat(MAX_DOOM_NOTIFICATION_BODY_CHARACTERS) });
    expect(request?.body).toHaveLength(MAX_DOOM_NOTIFICATION_BODY_CHARACTERS);
    expect(request?.body.endsWith('🙂')).toBe(true);
  });

  it('discovers the request service only while its provider fiber is live', async () => {
    expect(DOOM_NOTIFICATION_ENTRY_TYPE).toBe('doom-notification');
    const root = new Context();
    expect(() => requireDoomNotificationService(root)).toThrow(
      'Doom notification is unavailable. Load a notification provider.',
    );
    const request = vi.fn();
    const service: DoomNotificationService = { generation: 'notification-generation', request };
    const fiber = root.plugin((context) => context.provide(DOOM_NOTIFICATION_SERVICE, service));
    await fiber.await();

    await requireDoomNotificationService(root).request({ body: 'Task list created.' });
    expect(request).toHaveBeenCalledWith({ body: 'Task list created.' });
    expect(readDoomNotificationService(root)).toBe(service);

    await fiber.dispose();
    expect(readDoomNotificationService(root)).toBeUndefined();
    await root.fiber.dispose();
  });

  it('keeps the internal schema implementation aligned with the public notification export', async () => {
    const complete = internalNotification.normalizeDoomNotificationRequest({
      title: ' Title ',
      subtitle: ' Subtitle ',
      body: ` ${'x'.repeat(MAX_DOOM_NOTIFICATION_BODY_CHARACTERS + 1)} `,
      level: 'error',
    });
    expect(complete).toMatchObject({ title: 'Title', subtitle: 'Subtitle', level: 'error' });
    expect(complete?.body).toHaveLength(MAX_DOOM_NOTIFICATION_BODY_CHARACTERS);
    expect(internalNotification.normalizeDoomNotificationRequest({ body: '\u0000\u007f' })).toBeUndefined();
    expect(internalNotification.normalizeDoomNotificationRequest(null)).toBeUndefined();
    expect(internalNotification.createDoomNotificationEntryData({ body: 'Saved.' })).toEqual({
      version: 1,
      title: '',
      subtitle: '',
      body: 'Saved.',
      level: 'info',
    });
    expect(internalNotification.createDoomNotificationEntryData({ body: 1 })).toBeUndefined();
    expect(internalNotification.isDoomNotificationRequest({ body: 'Saved.' })).toBe(true);
    expect(internalNotification.isDoomNotificationRequest({ body: '' })).toBe(false);
    expect(
      internalNotification.isDoomNotificationEntryData({
        version: 1,
        title: '',
        subtitle: '',
        body: 'Saved.',
        level: 'info',
      }),
    ).toBe(true);

    const root = new Context();
    expect(internalNotification.readDoomNotificationService(root)).toBeUndefined();
    expect(() => internalNotification.requireDoomNotificationService(root)).toThrow('unavailable');
    const service: DoomNotificationService = { generation: 'internal', request: vi.fn() };
    const fiber = root.plugin((context) => context.provide(DOOM_NOTIFICATION_SERVICE, service));
    await fiber.await();
    expect(internalNotification.requireDoomNotificationService(root)).toBe(service);
    await root.fiber.dispose();
  });
});

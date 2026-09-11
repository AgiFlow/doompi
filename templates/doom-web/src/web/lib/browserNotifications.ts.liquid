import type { DoomNotificationEntryData } from '@agimon-ai/doompi-extension-contracts/notification';

export type BrowserNotificationDeliveryStatus =
  | 'delivered'
  | 'unsupported'
  | 'permission-default'
  | 'permission-denied'
  | 'constructor-error';

export type BrowserNotificationPermissionStatus = NotificationPermission | 'unsupported' | 'request-error';

/** Reports this browser's current permission without prompting. */
export function browserNotificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Requests permission. Call only in a direct user interaction handler. */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionStatus> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'request-error';
  }
}

/** Delivers one validated live entry when the browser has already granted permission. */
export function deliverBrowserNotification(
  sessionId: string,
  entryId: string,
  data: DoomNotificationEntryData,
): BrowserNotificationDeliveryStatus {
  if (typeof Notification === 'undefined') return 'unsupported';
  const permission = Notification.permission;
  if (permission !== 'granted') return permission === 'denied' ? 'permission-denied' : 'permission-default';

  try {
    const body = data.subtitle === '' ? data.body : `${data.subtitle}\n${data.body}`;
    new Notification(data.title || 'DoomPi', {
      body,
      tag: `doompi:${encodeURIComponent(sessionId)}:${encodeURIComponent(entryId)}`,
    });
    return 'delivered';
  } catch {
    return 'constructor-error';
  }
}

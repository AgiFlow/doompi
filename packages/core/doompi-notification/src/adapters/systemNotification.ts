import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { notificationBody } from '../services/notificationText.ts';
import type { DesktopNotification } from '../types/notifications.ts';

const CMUX_COMMAND = 'cmux';
const COMMAND_TIMEOUT_MS = 3_000;
const DARWIN_PLATFORM = 'darwin';
const OSASCRIPT_COMMAND = 'osascript';
const OSASCRIPT_EXPRESSION_FLAG = '-e';

async function execute(pi: ExtensionAPI, command: string, args: string[]): Promise<boolean> {
  try {
    const result = await pi.exec(command, args, { timeout: COMMAND_TIMEOUT_MS });
    return result.code === 0;
  } catch {
    // A notifier that is not installed is the ordinary case, not a fault: report
    // "not delivered" and let the caller decide whether another one exists.
    return false;
  }
}

/**
 * Delivers one desktop notification on a best-effort basis.
 *
 * cmux is tried first because it routes the notification to the window the
 * session actually lives in. Only macOS has a second option worth attempting,
 * and a host with neither stays silent rather than failing the turn.
 */
export async function sendSystemNotification(
  pi: ExtensionAPI,
  notification: DesktopNotification,
  platform: string = process.platform,
): Promise<void> {
  const body = notificationBody(notification.body);
  const sentToCmux = await execute(pi, CMUX_COMMAND, [
    'notify',
    '--title',
    notification.title,
    '--subtitle',
    notification.subtitle,
    '--body',
    body,
  ]);
  if (sentToCmux || platform !== DARWIN_PLATFORM) return;

  await execute(pi, OSASCRIPT_COMMAND, [
    OSASCRIPT_EXPRESSION_FLAG,
    'on run argv',
    OSASCRIPT_EXPRESSION_FLAG,
    'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)',
    OSASCRIPT_EXPRESSION_FLAG,
    'end run',
    notification.title,
    notification.subtitle,
    body,
  ]);
}

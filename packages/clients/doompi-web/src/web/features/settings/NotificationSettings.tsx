import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import {
  browserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermissionStatus,
} from '../../lib/browserNotifications.ts';

const STATUS_COPY: Record<BrowserNotificationPermissionStatus, string> = {
  granted: 'browser notifications are allowed',
  denied: 'browser notifications are blocked in this browser',
  default: 'browser permission has not been decided',
  unsupported: 'this browser does not support notifications',
  'request-error': 'the browser could not complete the permission request',
};

/** Browser-owned notification permission. DoomPi keeps no separate setting. */
export function NotificationSettings() {
  const [status, setStatus] = useState<BrowserNotificationPermissionStatus>(browserNotificationPermission);

  const requestPermission = async (): Promise<void> => {
    setStatus(await requestBrowserNotificationPermission());
  };

  return (
    <div data-testid="notification-settings" className="flex max-w-[640px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-bold text-doom-hi">notifications</h2>
        <p className="text-[11px] leading-relaxed text-doom-dim">
          allow this browser to show notifications published by live DoomPi sessions. replayed and historical entries
          never create browser notifications.
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 rounded border border-doom-border bg-doom-panel p-3">
        <p data-testid="notification-permission-status" className="text-[11px] text-doom-dim">
          {STATUS_COPY[status]}
        </p>
        {status === 'default' || status === 'request-error' ? (
          <Button size="sm" data-testid="notification-permission-request" onClick={() => void requestPermission()}>
            allow notifications
          </Button>
        ) : null}
        {status === 'denied' ? (
          <p className="text-[11px] text-doom-dim">enable notifications for this site in your browser settings</p>
        ) : null}
      </div>
    </div>
  );
}

import { Button } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';
import {
  browserNotificationPermission,
  type BrowserNotificationPermissionStatus,
} from '../../lib/browserNotifications.ts';
import { disableLivePush, enableLivePush, livePushStatus, type LivePushStatus } from '../../lib/livePush.ts';

const STATUS_COPY: Record<BrowserNotificationPermissionStatus, string> = {
  granted: 'browser notifications are allowed',
  denied: 'browser notifications are blocked in this browser',
  default: 'browser permission has not been decided',
  unsupported: 'this browser does not support notifications',
  'request-error': 'the browser could not complete the permission request',
};

const PUSH_COPY: Record<LivePushStatus, string> = {
  enabled: 'closed-app live alerts are enabled for this paired device',
  disabled: 'closed-app live alerts are off',
  denied: 'notifications are blocked in this browser',
  unsupported: 'Web Push is unavailable here; on iPhone, install DoomPi on the Home Screen first',
  error: 'the live Push subscription could not be updated',
};

/** Browser-owned notification permission plus an ephemeral, device-bound Push subscription. */
export function NotificationSettings() {
  const [status, setStatus] = useState<BrowserNotificationPermissionStatus>(browserNotificationPermission);
  const [pushStatus, setPushStatus] = useState<LivePushStatus>('disabled');

  useEffect(() => {
    void livePushStatus().then(setPushStatus);
  }, []);

  const enable = async (): Promise<void> => {
    setPushStatus(await enableLivePush());
    setStatus(browserNotificationPermission());
  };

  const disable = async (): Promise<void> => {
    setPushStatus(await disableLivePush());
  };

  return (
    <div data-testid="notification-settings" className="flex max-w-[640px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-bold text-doom-hi">notifications</h2>
        <p className="text-[11px] leading-relaxed text-doom-dim">
          Open pages receive full live notification text. A closed installed app receives only a generic live alert,
          with no session content and no replay after downtime.
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 rounded border border-doom-border bg-doom-panel p-3">
        <p data-testid="notification-permission-status" className="text-[11px] text-doom-dim">
          {STATUS_COPY[status]}
        </p>
        <p data-testid="push-subscription-status" className="text-[11px] text-doom-dim">
          {PUSH_COPY[pushStatus]}
        </p>
        {pushStatus === 'enabled' ? (
          <Button size="sm" variant="outline" data-testid="push-disable" onClick={() => void disable()}>
            disable closed-app alerts
          </Button>
        ) : pushStatus !== 'denied' && pushStatus !== 'unsupported' ? (
          <Button size="sm" data-testid="notification-permission-request" onClick={() => void enable()}>
            enable closed-app alerts
          </Button>
        ) : null}
        {status === 'denied' ? (
          <p className="text-[11px] text-doom-dim">enable notifications for this site in your browser settings</p>
        ) : null}
      </div>
    </div>
  );
}

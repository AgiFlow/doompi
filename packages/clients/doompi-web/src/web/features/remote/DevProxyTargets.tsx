import { useEffect, useState } from 'react';
import { Button, Input, SectionLabel } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import {
  createDevProxyTarget,
  deleteDevProxyTarget,
  devProxyStore,
  refreshDevProxyTargets,
} from '../../stores/devProxyStore';
import { DEV_PROXY_PREFIX } from '../../../types/devProxy';

/**
 * Local dev servers reachable through the cockpit's own address.
 *
 * The `base` line is shown rather than described. A sub-path proxy needs the
 * application to know its base path, exactly as it would behind nginx, and a
 * developer who has to work that out from prose will conclude the feature is
 * broken when their assets 404.
 *
 * Adding a target is host-only, so on a phone the form is replaced by the
 * reason rather than rendered as a button that would be refused.
 */
export function DevProxyTargets() {
  const state = useStore(devProxyStore);
  const [name, setName] = useState('');
  const [port, setPort] = useState('');

  useEffect(() => {
    void refreshDevProxyTargets();
  }, []);

  const submit = async (): Promise<void> => {
    if (await createDevProxyTarget(name.trim(), Number(port))) {
      setName('');
      setPort('');
    }
  };

  return (
    <div className="flex w-full flex-col gap-1.5">
      <SectionLabel>dev sites</SectionLabel>
      <span className="text-sm text-doom-faint">
        Reach a local dev server from a paired device, on this same address.
      </span>

      {state.targets.map((target) => (
        <div
          key={target.name}
          data-testid={`dev-proxy-target-${target.name}`}
          className="flex items-center justify-between gap-3 rounded border border-doom-border px-2.5 py-1.5"
        >
          <span className="flex min-w-0 flex-col">
            <a
              href={`${DEV_PROXY_PREFIX}${target.name}/`}
              target="_blank"
              rel="noreferrer"
              className="truncate text-sm text-doom-hi underline"
              data-testid={`dev-proxy-open-${target.name}`}
            >
              {DEV_PROXY_PREFIX}
              {target.name}/
            </a>
            <span className="truncate text-xs text-doom-faint">
              port {target.port} &middot; set base: &apos;{DEV_PROXY_PREFIX}
              {target.name}/&apos; in the dev server
            </span>
          </span>
          {state.canRegister ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`dev-proxy-remove-${target.name}`}
              onClick={() => void deleteDevProxyTarget(target.name)}
            >
              remove
            </Button>
          ) : null}
        </div>
      ))}

      {state.canRegister ? (
        <div className="flex items-center gap-2">
          <Input
            aria-label="dev site name"
            data-testid="dev-proxy-name"
            placeholder="storefront"
            className="min-w-0 flex-1"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            aria-label="dev site port"
            data-testid="dev-proxy-port"
            type="number"
            min={1}
            max={65_535}
            placeholder="3000"
            className="w-24"
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="dev-proxy-add"
            disabled={state.busy || name.trim() === '' || port === ''}
            onClick={() => void submit()}
          >
            add
          </Button>
        </div>
      ) : (
        <span className="text-sm text-doom-faint">
          Add a dev site on the host. A paired device can open the ones already listed, but not name new ones.
        </span>
      )}

      {state.error === undefined ? null : (
        <span data-testid="dev-proxy-error" className="text-sm text-doom-warn">
          {state.error}
        </span>
      )}
    </div>
  );
}

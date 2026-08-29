import { Button, Input, RadioGroup, RadioGroupCard } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';
import type { TunnelConfig } from '../../../types/remoteAccess.ts';
import { updateRemoteSettings } from '../../stores/remoteAccessStore.ts';

const PUBLIC_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

function namedTunnel(tunnel: TunnelConfig): Extract<TunnelConfig, { kind: 'named' }> {
  return tunnel.kind === 'named' ? tunnel : { kind: 'named', hostname: '' };
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Selects a rotating quick tunnel or the stable named tunnel needed for a custom domain and passkeys. */
export function TunnelSettings({ tunnel }: { tunnel: TunnelConfig }) {
  const [draft, setDraft] = useState<TunnelConfig>(tunnel);

  useEffect(() => setDraft(tunnel), [tunnel]);

  const hostname = draft.kind === 'named' ? draft.hostname.trim() : '';
  const invalidHostname = draft.kind === 'named' && !PUBLIC_HOSTNAME.test(hostname);
  const changed = JSON.stringify(draft) !== JSON.stringify(tunnel);

  function updateNamed(patch: Partial<Extract<TunnelConfig, { kind: 'named' }>>): void {
    setDraft((current) => ({ ...namedTunnel(current), ...patch }));
  }

  async function save(): Promise<void> {
    if (draft.kind === 'quick') {
      await updateRemoteSettings({ tunnel: draft });
      return;
    }
    const tokenFile = optional(draft.tokenFile ?? '');
    const name = optional(draft.name ?? '');
    const configFile = optional(draft.configFile ?? '');
    await updateRemoteSettings({
      tunnel: {
        kind: 'named',
        hostname,
        ...(tokenFile === undefined ? {} : { tokenFile }),
        ...(name === undefined ? {} : { name }),
        ...(configFile === undefined ? {} : { configFile }),
      },
    });
  }

  return (
    <section className="flex flex-col gap-3" data-testid="remote-tunnel-settings">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-doom-hi">Cloudflare tunnel</span>
        <span className="text-[11px] text-doom-faint">Use a named tunnel for a stable custom domain and passkeys.</span>
      </div>

      <RadioGroup
        value={draft.kind}
        onValueChange={(kind) => setDraft(kind === 'named' ? namedTunnel(draft) : { kind: 'quick' })}
        className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2"
        aria-label="Cloudflare tunnel type"
      >
        <RadioGroupCard value="quick" data-testid="remote-tunnel-quick">
          <span className="block text-xs text-doom-hi">quick tunnel</span>
          <span className="block text-[10px] text-doom-faint">No account, rotating address</span>
        </RadioGroupCard>
        <RadioGroupCard value="named" data-testid="remote-tunnel-named">
          <span className="block text-xs text-doom-hi">named tunnel</span>
          <span className="block text-[10px] text-doom-faint">Your domain, durable access</span>
        </RadioGroupCard>
      </RadioGroup>

      {draft.kind === 'named' ? (
        <div className="flex flex-col gap-2 rounded-md border border-doom-border bg-doom-deep p-3">
          <label className="flex flex-col gap-1 text-[11px] text-doom-faint">
            hostname
            <Input
              data-testid="remote-tunnel-hostname"
              value={draft.hostname}
              placeholder="doom.example.com"
              aria-invalid={invalidHostname}
              onChange={(event) => updateNamed({ hostname: event.target.value })}
            />
          </label>
          {invalidHostname ? (
            <p className="text-[10px] text-doom-red">Enter a hostname only, without https://, a port, or a path.</p>
          ) : null}
          <label className="flex flex-col gap-1 text-[11px] text-doom-faint">
            token file
            <Input
              data-testid="remote-tunnel-token-file"
              value={draft.tokenFile ?? ''}
              placeholder="/Users/you/.cloudflared/doompi.token"
              onChange={(event) => updateNamed({ tokenFile: event.target.value })}
            />
          </label>
          <p className="text-[10px] text-doom-faint">
            Store the Cloudflare connector token in this local file. The token itself is never saved in browser
            settings.
          </p>
          <details className="text-[11px] text-doom-faint">
            <summary className="cursor-pointer text-doom-text">locally managed tunnel options</summary>
            <div className="mt-2 flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                tunnel name
                <Input
                  data-testid="remote-tunnel-name"
                  value={draft.name ?? ''}
                  placeholder="doompi"
                  onChange={(event) => updateNamed({ name: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                config file
                <Input
                  data-testid="remote-tunnel-config-file"
                  value={draft.configFile ?? ''}
                  placeholder="/Users/you/.cloudflared/config.yml"
                  onChange={(event) => updateNamed({ configFile: event.target.value })}
                />
              </label>
            </div>
          </details>
        </div>
      ) : null}

      <div className="flex flex-col items-stretch gap-2 min-[480px]:flex-row min-[480px]:items-center min-[480px]:justify-between min-[480px]:gap-3">
        <span className="text-[10px] leading-relaxed text-doom-faint">
          Changes apply the next time remote access starts.
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid="remote-tunnel-save"
          disabled={!changed || invalidHostname}
          onClick={() => void save()}
          className="w-full min-[480px]:w-auto"
        >
          save tunnel
        </Button>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { AuthMethodType, LoginFlowSnapshot, ProviderAuthSummary } from '../../../types/auth.ts';
import { Chip, Dot } from '../../components/Chip.tsx';
import { answerLogin, cancelLogin, listProviders, logoutProvider, readLogin, startLogin } from '../../lib/authApi.ts';
import { LoginFlowDialog, METHOD_LABEL } from './LoginFlowDialog.tsx';

const FLOW_POLL_MS = 500;
/** The auth source Pi reports for a credential its own /login stored; the only kind /logout removes. */
const STORED_SOURCE = 'stored';

const actionClass =
  'rounded border border-doom-border px-2.5 py-1 text-[10px] text-doom-dim hover:border-doom-blue/50 hover:text-doom-hi disabled:opacity-40';

function statusText(provider: ProviderAuthSummary): string {
  if (!provider.authenticated) return 'not authenticated';
  const { type, source } = provider.authenticated;
  const via = source === STORED_SOURCE ? 'stored' : source;
  return `authenticated · ${METHOD_LABEL[type]}${via ? ` · ${via}` : ''}`;
}

function ProviderRow({
  provider,
  busy,
  onLogin,
  onLogout,
}: {
  provider: ProviderAuthSummary;
  busy: boolean;
  onLogin: (type: AuthMethodType) => void;
  onLogout: () => void;
}) {
  const authenticated = provider.authenticated !== undefined;
  return (
    <li
      data-testid={`provider-${provider.id}`}
      data-authenticated={authenticated}
      className="flex items-center gap-3 rounded-md border border-doom-border bg-doom-panel px-3.5 py-2.5"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12px] font-bold text-doom-hi">{provider.name}</span>
        <span className="truncate text-[10px] text-doom-faint">{provider.id}</span>
      </div>
      <Chip tone={authenticated ? 'green' : 'neutral'} testId={`provider-status-${provider.id}`}>
        <Dot tone={authenticated ? 'green' : 'neutral'} />
        {statusText(provider)}
      </Chip>
      {provider.methods.map((method) => (
        <button
          key={method.type}
          type="button"
          data-testid={`provider-login-${method.type}-${provider.id}`}
          title={method.label}
          disabled={busy}
          onClick={() => onLogin(method.type)}
          className={actionClass}
        >
          sign in · {METHOD_LABEL[method.type]}
        </button>
      ))}
      {provider.authenticated?.source === STORED_SOURCE ? (
        <button
          type="button"
          data-testid={`provider-logout-${provider.id}`}
          disabled={busy}
          onClick={onLogout}
          className={`${actionClass} hover:border-doom-red/50 hover:text-doom-red`}
        >
          sign out
        </button>
      ) : null}
      {provider.methods.length === 0 ? (
        <span className="text-[10px] text-doom-faint">ambient credentials only</span>
      ) : null}
    </li>
  );
}

/**
 * The providers page: what Pi can sign in to on the hub's machine, and
 * whether it has. A login runs on the hub; this page polls its flow and
 * relays the one question it may ask.
 */
export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderAuthSummary[] | null>(null);
  const [error, setError] = useState('');
  const [flow, setFlow] = useState<LoginFlowSnapshot | null>(null);
  /** The provider with a request in flight, so its buttons cannot double-fire. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const result = await listProviders();
    if ('providers' in result) {
      setProviders(result.providers);
      setError('');
    } else {
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll the running flow one request at a time; once it settles, the list
  // is re-read so the provider's chip reflects the outcome.
  const flowId = flow?.id;
  const running = flow?.status === 'running';
  useEffect(() => {
    if (flowId === undefined || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      const result = await readLogin(flowId);
      if (stopped) return;
      if ('error' in result) {
        setFlow((current) =>
          current && current.id === flowId ? { ...current, status: 'failed', error: result.error } : current,
        );
        return;
      }
      setFlow(result.flow);
      if (result.flow.status !== 'running') {
        void reload();
        return;
      }
      timer = setTimeout(() => void poll(), FLOW_POLL_MS);
    };
    timer = setTimeout(() => void poll(), FLOW_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [flowId, running, reload]);

  const begin = async (providerId: string, type: AuthMethodType): Promise<void> => {
    setBusyId(providerId);
    const result = await startLogin(providerId, type);
    setBusyId(null);
    if ('flow' in result) setFlow(result.flow);
    else setError(result.error);
  };

  const answer = async (promptId: string, value: string): Promise<void> => {
    if (!flow) return;
    const result = await answerLogin(flow.id, promptId, value);
    if ('flow' in result) setFlow(result.flow);
    else setError(result.error);
  };

  const cancel = async (): Promise<void> => {
    if (!flow) return;
    const result = await cancelLogin(flow.id);
    setFlow('flow' in result ? result.flow : null);
    void reload();
  };

  const signOut = async (providerId: string): Promise<void> => {
    setBusyId(providerId);
    const result = await logoutProvider(providerId);
    if ('error' in result) setError(result.error);
    else await reload();
    setBusyId(null);
  };

  return (
    <div data-testid="provider-settings" className="flex max-w-[780px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-bold text-doom-hi">providers</h2>
        <p className="text-[11px] leading-relaxed text-doom-dim">
          sign in to the model providers Pi can use. credentials land in Pi&apos;s auth.json on this machine, so every
          session shares them.
        </p>
      </div>
      {error ? (
        <p data-testid="provider-settings-error" className="text-[11px] leading-relaxed text-doom-red">
          {error}
        </p>
      ) : null}
      {providers === null && !error ? <p className="text-[11px] text-doom-faint">reading providers…</p> : null}
      {providers ? (
        <ul data-testid="provider-list" className="flex flex-col gap-1.5">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              busy={busyId === provider.id}
              onLogin={(type) => void begin(provider.id, type)}
              onLogout={() => void signOut(provider.id)}
            />
          ))}
        </ul>
      ) : null}
      {flow ? (
        <LoginFlowDialog
          flow={flow}
          onAnswer={(promptId, value) => void answer(promptId, value)}
          onCancel={() => void cancel()}
          onClose={() => setFlow(null)}
        />
      ) : null}
    </div>
  );
}

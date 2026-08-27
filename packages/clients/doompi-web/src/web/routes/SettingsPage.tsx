import { Button } from '@agimon-ai/doompi-web-components';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import { SessionRail } from '../features/sessions/SessionRail.tsx';
import { AppearanceSettings } from '../features/settings/AppearanceSettings.tsx';
import { ContributedSettings } from '../features/settings/ContributedSettings.tsx';
import { PluginSettings } from '../features/settings/PluginSettings.tsx';
import { ProviderSettings } from '../features/settings/ProviderSettings.tsx';
import { SettingsMenu } from '../features/settings/SettingsMenu.tsx';
import { DEFAULT_SETTINGS_SECTION, settingsSection } from '../lib/settingsSections.ts';
import { sessionsStore } from '../stores/sessionsStore.ts';

/**
 * The settings pages, in the cockpit's frame: the rail stays so a session is
 * one click away, and the main column becomes a section menu and its page.
 * An unknown section falls back to the first one.
 */
export function SettingsPage() {
  const { section } = useParams({ strict: false });
  const navigate = useNavigate();
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const [railOpen, setRailOpen] = useState(false);
  const current = settingsSection(section);

  useEffect(() => {
    if (current) return;
    void navigate({ to: '/settings/$section', params: { section: DEFAULT_SETTINGS_SECTION }, replace: true });
  }, [current, navigate]);

  return (
    <div data-testid="settings" className="relative flex h-full min-w-0 overflow-hidden">
      <aside
        data-testid="session-rail-panel"
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(300px,calc(100vw-48px))] shrink-0 flex-col overflow-y-auto border-r border-doom-border bg-doom-rail transition-transform md:visible md:static md:z-auto md:w-[300px] md:translate-x-0 ${railOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'}`}
      >
        <SessionRail onDismiss={() => setRailOpen(false)} />
      </aside>
      {railOpen ? (
        <Button
          variant="ghost"
          data-testid="mobile-drawer-backdrop"
          aria-label="hide sessions"
          className="fixed inset-0 z-30 h-auto w-auto rounded-none bg-black/55 p-0 hover:bg-black/55 md:hidden"
          onClick={() => setRailOpen(false)}
        />
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-doom-border px-2 sm:px-5">
          <span className="flex min-w-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              data-testid="mobile-sessions-open"
              title="show sessions"
              aria-label="show sessions"
              onClick={() => setRailOpen(true)}
              className="shrink-0 text-[16px] text-doom-dim md:hidden"
            >
              <span aria-hidden>☰</span>
            </Button>
            <span className="truncate text-[13px] font-bold text-doom-hi">settings</span>
          </span>
          <Button asChild variant="ghost" size="sm">
            {activeId !== null ? (
              <Link to="/session/$sessionId" params={{ sessionId: activeId }} data-testid="settings-close">
                back to session
              </Link>
            ) : (
              <Link to="/" data-testid="settings-close">
                back
              </Link>
            )}
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <SettingsMenu active={current?.id} />
          <section data-testid="settings-content" className="min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            {current?.id === 'providers' ? <ProviderSettings /> : null}
            {current?.id === 'appearance' ? <AppearanceSettings /> : null}
            {current?.id === 'plugins' ? <PluginSettings /> : null}
            {current?.contribution === undefined ? null : <ContributedSettings section={current.contribution} />}
          </section>
        </div>
      </main>
    </div>
  );
}

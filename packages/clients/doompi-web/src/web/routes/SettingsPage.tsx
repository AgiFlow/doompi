import { Button } from '@agimon-ai/doompi-web-components';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import { SessionRail } from '../features/sessions/SessionRail.tsx';
import { AppearanceSettings } from '../features/settings/AppearanceSettings.tsx';
import { ContributedSettings } from '../features/settings/ContributedSettings.tsx';
import { ImageSettings } from '../features/settings/ImageSettings.tsx';
import { NotificationSettings } from '../features/settings/NotificationSettings.tsx';
import { PluginSettings } from '../features/settings/PluginSettings.tsx';
import { RepositoryWorkspace } from '../features/settings/RepositoryWorkspace.tsx';
import { ProviderSettings } from '../features/settings/ProviderSettings.tsx';
import { RemoteControlSettings } from '../features/settings/RemoteControlSettings.tsx';
import { SettingsMenu } from '../features/settings/SettingsMenu.tsx';
import { SettingsPanelHost } from '../features/settings/SettingsPanelHost.tsx';
import {
  DEFAULT_REPOSITORY_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
  settingsSection,
} from '../lib/settingsSections.ts';
import { sessionsStore } from '../stores/sessionsStore.ts';
import { useWebPluginRegistry } from '../stores/useWebPluginRegistry.ts';

/**
 * The settings pages, in the cockpit's frame: the rail stays so a session is
 * one click away, and the main column becomes a section menu and its page.
 * An unknown section falls back to the first one.
 */
export function SettingsPage() {
  useWebPluginRegistry();
  const { section } = useParams({ strict: false });
  const navigate = useNavigate();
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const [railOpen, setRailOpen] = useState(false);
  const current = settingsSection(section);
  const workspace = current?.workspace ?? 'general';

  useEffect(() => {
    if (current) return;
    void navigate({
      to: '/settings/$section',
      params: { section: DEFAULT_SETTINGS_SECTION },
      replace: true,
    });
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
        <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-b border-doom-border px-3 py-2 sm:flex sm:h-12 sm:justify-between sm:px-5 sm:py-0">
          <span className="order-1 flex min-w-0 items-center gap-1.5 sm:order-none">
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
          <nav
            className="order-3 col-span-2 flex w-full items-center gap-0.5 rounded-md border border-doom-border bg-doom-panel p-0.5 sm:order-none sm:w-auto"
            aria-label="settings workspace"
          >
            <Button
              asChild
              variant={workspace === 'general' ? 'outline' : 'ghost'}
              size="xs"
              className="flex-1 sm:flex-none"
            >
              <Link
                to="/settings/$section"
                params={{ section: DEFAULT_SETTINGS_SECTION }}
                data-testid="settings-workspace-general"
              >
                general
              </Link>
            </Button>
            <Button
              asChild
              variant={workspace === 'repository' ? 'outline' : 'ghost'}
              size="xs"
              className="flex-1 sm:flex-none"
            >
              <Link
                to="/settings/$section"
                params={{ section: DEFAULT_REPOSITORY_SETTINGS_SECTION }}
                data-testid="settings-workspace-repository"
              >
                repository
              </Link>
            </Button>
          </nav>
          <Button asChild variant="ghost" size="sm" className="order-2 sm:order-none">
            {activeId !== null ? (
              <Link to="/session/$sessionId" params={{ sessionId: activeId }} data-testid="settings-close">
                <span className="sm:hidden">back</span>
                <span className="hidden sm:inline">back to session</span>
              </Link>
            ) : (
              <Link to="/" data-testid="settings-close">
                back
              </Link>
            )}
          </Button>
        </header>
        {current?.workspace === 'repository' ? (
          <RepositoryWorkspace current={current} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <SettingsMenu active={current?.id} workspace="general" />
            <section
              data-testid="settings-content"
              className="min-w-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 sm:py-5 lg:px-8"
            >
              {/* One column width for every page, so moving between sections does
                  not re-flow the reading line. */}
              <div className="flex w-full max-w-[780px] flex-col gap-4">
                {current?.id === 'providers' ? <ProviderSettings /> : null}
                {current?.id === 'appearance' ? <AppearanceSettings /> : null}
                {current?.id === 'notifications' ? <NotificationSettings /> : null}
                {current?.id === 'images' ? <ImageSettings /> : null}
                {current?.id === 'remote' ? <RemoteControlSettings /> : null}
                {current?.id === 'plugins' ? <PluginSettings /> : null}
                {current?.contribution === undefined ? null : (
                  <ContributedSettings section={current.contribution} scope="global" />
                )}
                {current?.panel === undefined ? null : <SettingsPanelHost panel={current.panel} />}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

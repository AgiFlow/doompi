import { Button } from '@agimon-ai/doompi-web-components';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect } from 'react';
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
  const current = settingsSection(section);

  useEffect(() => {
    if (current) return;
    void navigate({ to: '/settings/$section', params: { section: DEFAULT_SETTINGS_SECTION }, replace: true });
  }, [current, navigate]);

  return (
    <div data-testid="settings" className="relative flex h-full overflow-hidden">
      <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-doom-border bg-doom-rail">
        <SessionRail />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-doom-border px-5">
          <span className="text-[13px] font-bold text-doom-hi">settings</span>
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
        <div className="flex min-h-0 flex-1">
          <SettingsMenu active={current?.id} />
          <section data-testid="settings-content" className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
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

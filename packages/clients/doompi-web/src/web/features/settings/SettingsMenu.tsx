import { Link } from '@tanstack/react-router';
import { settingsSections, type SettingsWorkspace } from '../../lib/settingsSections.ts';

export function SettingsMenu({ active, workspace }: { active: string | undefined; workspace: SettingsWorkspace }) {
  return (
    <nav
      data-testid="settings-menu"
      className="flex w-full shrink-0 gap-0.5 overflow-x-auto border-b border-doom-border px-2.5 py-2 [scrollbar-width:none] sm:w-[220px] sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:py-3 [&::-webkit-scrollbar]:hidden"
    >
      <span className="hidden px-[11px] pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-wide text-doom-faint sm:block">
        {workspace}
      </span>
      {settingsSections(workspace).map((section) => {
        const current = section.id === active;
        return (
          <Link
            key={section.id}
            to="/settings/$section"
            params={{ section: section.id }}
            data-testid={`settings-section-${section.id}`}
            data-active={current}
            className={`flex min-w-32 shrink-0 flex-col gap-0.5 rounded-md px-[11px] py-2 transition-colors sm:min-w-0 sm:shrink ${
              current ? 'bg-doom-tint-blue' : 'hover:bg-doom-panel'
            }`}
          >
            <span className={`text-[12px] font-bold ${current ? 'text-doom-blue' : 'text-doom-hi'}`}>
              {section.label}
            </span>
            <span className="text-[10px] leading-snug text-doom-faint">{section.detail}</span>
          </Link>
        );
      })}
    </nav>
  );
}

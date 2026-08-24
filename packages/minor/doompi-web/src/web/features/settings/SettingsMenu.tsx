import { Link } from '@tanstack/react-router';
import { SETTINGS_SECTIONS } from '../../lib/settingsSections.ts';

export function SettingsMenu({ active }: { active: string | undefined }) {
  return (
    <nav
      data-testid="settings-menu"
      className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r border-doom-border px-2.5 py-3"
    >
      {SETTINGS_SECTIONS.map((section) => {
        const current = section.id === active;
        return (
          <Link
            key={section.id}
            to="/settings/$section"
            params={{ section: section.id }}
            data-testid={`settings-section-${section.id}`}
            data-active={current}
            className={`flex flex-col gap-0.5 rounded-md px-[11px] py-2 ${
              current ? 'bg-[#21313F]' : 'hover:bg-doom-panel'
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

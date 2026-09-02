import {
  Button,
  ChevronUpIcon,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  GearIcon,
} from '@agimon-ai/doompi-web-components';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { settingsSections, type SettingsSection, type SettingsWorkspace } from '../../lib/settingsSections.ts';

function SectionLinks({
  active,
  sections,
  onNavigate,
}: {
  active: string | undefined;
  sections: readonly SettingsSection[];
  onNavigate?: () => void;
}) {
  return sections.map((section) => {
    const current = section.id === active;
    return (
      <Link
        key={section.id}
        to="/settings/$section"
        params={{ section: section.id }}
        data-testid={`settings-section-${section.id}`}
        data-active={current}
        onClick={onNavigate}
        className={`flex min-w-0 items-center rounded-md px-[11px] py-1.5 transition-colors ${
          current ? 'bg-doom-tint-blue' : 'hover:bg-doom-panel'
        }`}
      >
        {/* Title only: each page repeats its own detail in the panel header, and
            eight stacked descriptions made the menu taller than the page. */}
        <span className={`truncate text-[12px] font-bold ${current ? 'text-doom-blue' : 'text-doom-hi'}`}>
          {section.label}
        </span>
      </Link>
    );
  });
}

export function SettingsMenu({ active, workspace }: { active: string | undefined; workspace: SettingsWorkspace }) {
  const [open, setOpen] = useState(false);
  const sections = settingsSections(workspace);
  const current = sections.find((section) => section.id === active) ?? sections[0];

  return (
    <>
      <div className="shrink-0 border-b border-doom-border bg-doom-panel/40 p-2 lg:hidden">
        <Button
          variant="outline"
          size="sm"
          data-testid="settings-menu-open"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="h-auto w-full justify-between gap-3 px-3 py-2 text-left whitespace-normal"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <GearIcon className="h-3.5 w-3.5 shrink-0 text-doom-blue" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[11px] font-bold text-doom-hi">{current?.label ?? workspace}</span>
              <span className="truncate text-[9px] font-normal text-doom-faint">{current?.detail}</span>
            </span>
          </span>
          <ChevronUpIcon className="h-3.5 w-3.5 shrink-0 text-doom-faint" />
        </Button>
      </div>

      <nav
        data-testid="settings-menu"
        className="hidden w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-doom-border px-2.5 py-3 lg:flex"
      >
        <span className="px-[11px] pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-wide text-doom-faint">
          {workspace}
        </span>
        <SectionLinks active={active} sections={sections} />
      </nav>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          width="lg"
          data-testid="settings-menu-sheet"
          aria-describedby={undefined}
          className="top-auto bottom-0 left-0 max-h-[min(72dvh,560px)] !w-full !max-w-none translate-x-0 translate-y-0 rounded-t-xl rounded-b-none border-x-0 border-b-0 data-[state=open]:animate-none lg:hidden"
        >
          <span aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-doom-border" />
          <DialogHeader dismissible closeLabel="close settings menu" className="py-2.5">
            <DialogTitle>{workspace} settings</DialogTitle>
          </DialogHeader>
          <DialogBody className="gap-1 p-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <nav aria-label={`${workspace} settings sections`} className="flex flex-col gap-1">
              <SectionLinks active={active} sections={sections} onNavigate={() => setOpen(false)} />
            </nav>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

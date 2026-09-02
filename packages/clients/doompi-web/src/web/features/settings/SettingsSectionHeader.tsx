import type { ReactNode } from 'react';

/**
 * The one heading every settings page wears: the section's name, then what the
 * page is for, on the line below.
 *
 * It exists because the pages disagreed. Host pages put the detail under the
 * title, contributed pages ran it inline beside the title, and the plugins page
 * had no title at all, so a reader moving between sections had to re-find the
 * heading each time. The menu no longer repeats the detail, which makes this
 * the only place it is written.
 */
export function SettingsSectionHeader({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  /** Trailing status the page owns, such as a scope warning. */
  children?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-bold text-doom-hi">{title}</h2>
        {children}
      </div>
      {detail === undefined || detail === '' ? null : (
        <p className="text-[11px] leading-relaxed text-doom-dim">{detail}</p>
      )}
    </header>
  );
}

import { CheckIcon, RadioGroup, RadioGroupCard } from '@agimon-ai/doompi-web-components';
import type { ThemeConfig } from '@agimon-ai/doompi-web-components/theme';
import { useStore } from '@tanstack/react-store';
import { availableThemes, selectTheme, themeStore } from '../../stores/themeStore.ts';

/** The accents a swatch previews, in the order the bar shows them. */
const SWATCH_ACCENTS = ['blue', 'green', 'yellow', 'red', 'magenta', 'cyan'] as const;

/** A miniature of the cockpit in the theme's own colours, drawn from its tokens rather than the page's. */
function ThemeSwatch({ theme }: { theme: ThemeConfig }) {
  const { tokens } = theme;
  return (
    <div
      aria-hidden
      className="flex h-[74px] w-full overflow-hidden rounded border"
      style={{ backgroundColor: tokens.bg, borderColor: tokens.border }}
    >
      <div className="flex w-[34%] flex-col gap-1 p-1.5" style={{ backgroundColor: tokens.rail }}>
        <span className="h-[7px] w-full rounded-sm" style={{ backgroundColor: tokens.selected }} />
        <span className="h-[7px] w-3/4 rounded-sm" style={{ backgroundColor: tokens.panel }} />
        <span className="h-[7px] w-3/4 rounded-sm" style={{ backgroundColor: tokens.panel }} />
      </div>
      <div className="flex flex-1 flex-col justify-between p-1.5">
        <div className="flex flex-col gap-1">
          <span className="h-[5px] w-2/3 rounded-sm" style={{ backgroundColor: tokens.text }} />
          <span className="h-[5px] w-1/2 rounded-sm" style={{ backgroundColor: tokens.dim }} />
        </div>
        <div className="flex gap-1">
          {SWATCH_ACCENTS.map((accent) => (
            <span key={accent} className="h-2 w-2 rounded-full" style={{ backgroundColor: tokens[accent] }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The appearance page: the shipped themes as a picker. A choice applies at
 * once and is remembered per browser; the token contract the themes fill
 * is documented in the component library.
 */
export function AppearanceSettings() {
  const current = useStore(themeStore, (state) => state.name);
  return (
    <div data-testid="appearance-settings" className="flex max-w-[780px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-bold text-doom-hi">appearance</h2>
        <p className="text-[11px] leading-relaxed text-doom-dim">
          pick the theme the cockpit renders with. the choice is remembered in this browser; every colour on the page,
          including the plugins&apos; tabs, follows it.
        </p>
      </div>
      <RadioGroup
        aria-label="theme"
        data-testid="theme-list"
        className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3"
        value={current}
        onValueChange={selectTheme}
      >
        {availableThemes().map((theme) => {
          const selected = theme.name === current;
          return (
            <RadioGroupCard
              key={theme.name}
              value={theme.name}
              data-testid={`theme-${theme.name}`}
              data-selected={selected}
              className="flex flex-col gap-2 p-2.5"
            >
              <ThemeSwatch theme={theme} />
              <span className="flex items-center gap-2">
                <span className={`flex-1 text-[12px] font-bold ${selected ? 'text-doom-blue' : 'text-doom-hi'}`}>
                  {theme.label}
                </span>
                <span className="text-[9px] text-doom-faint">{theme.scheme}</span>
                {selected ? <CheckIcon className="h-3 w-3 text-doom-blue" /> : null}
              </span>
            </RadioGroupCard>
          );
        })}
      </RadioGroup>
      <p className="text-[10px] leading-relaxed text-doom-faint">
        a theme is a JSON config of twenty palette tokens; see @agimon-ai/doompi-web-components for the contract.
      </p>
    </div>
  );
}

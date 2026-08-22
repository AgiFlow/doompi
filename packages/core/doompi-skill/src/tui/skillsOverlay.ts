/**
 * Skills: the `SPC e s` overlay.
 *
 * A tree of the skills this session loaded on the left, the selected skill's
 * frontmatter and body on the right. Everything listed is loaded, so the
 * surface answers "what do I have, and what does it cost" rather than doubling
 * as a domain browser.
 *
 * The tree is flat and always open: groups and owners are headings, only skills
 * take the selection. Rendering is pure: the catalogue is resolved once by the
 * caller and passed in, so `render(width)` returns lines with no side effects
 * and the whole surface can be asserted as text without a live terminal.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import { fitStyledLine, formatTokens } from '@agimon-ai/doompi-ui/rendering';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { SkillCatalog, SkillEntry } from '../adapters/skillCatalog.ts';

type ThemeColor = Parameters<Theme['fg']>[0];
type ThemeBg = Parameters<Theme['bg']>[0];

const MIN_WIDTH = 60;
/** A third for the tree, two thirds for the skill being read. */
const TREE_PANE_RATIO = 1 / 3;
/** One blank column each side of the pane divider so neither column touches it. */
const PANE_GUTTER = 1;
const MIN_PANE_WIDTH = 20;
const LABEL_COLUMN = 13;
/** Ceiling on the columns a row's right-hand tag may take from its label. */
const TAG_SHARE = 0.4;
const INDENT = 2;
const ELLIPSIS = '…';
const SELECTION_MARKER = '›';
const RULE = '─';
const KEY_TAB = '\t';
const KEY_ENTER = '\r';
const KEY_NEWLINE = '\n';
const KEY_BACKSPACE = '\x7f';
const FILTER_KEY = '/';
const BODY_PAGE = 10;

const TITLE = 'SKILLS';
const BREADCRUMB = 'SPC › e / extension › s / skills';
const HEADING = 'CATALOG';
const EMPTY_TREE = 'No skills discovered.';
const NO_SELECTION = 'Select a skill to read it.';
const UNREADABLE = 'Could not read SKILL.md.';

const TREE_HINTS: readonly (readonly [string, string])[] = [
  ['↑↓', 'select'],
  ['enter', 'use skill'],
  ['tab', 'detail pane'],
  ['/', 'filter'],
  ['esc', 'close'],
];
const BODY_HINTS: readonly (readonly [string, string])[] = [
  ['pgup/pgdn', 'scroll'],
  ['tab', 'tree'],
  ['esc', 'close'],
];
const FILTER_HINTS: readonly (readonly [string, string])[] = [
  ['type', 'to filter'],
  ['enter', 'keep'],
  ['esc', 'clear'],
];

export type SkillsOverlayResult = { kind: 'invoke'; skill: SkillEntry } | undefined;

export interface SkillsOverlayOptions {
  catalog: SkillCatalog;
  /** Repo root, so paths render relative rather than as absolute noise. */
  repoRoot: string;
  readFile?: (filePath: string) => string;
}

type RowKind = 'group' | 'owner' | 'skill';

interface TreeRow {
  kind: RowKind;
  depth: number;
  label: string;
  tag: string;
  /** Only a skill row carries one; group and owner rows are headings. */
  skill?: SkillEntry;
}

function fitRow(text: string, width: number): string {
  return fitStyledLine(text, width, ELLIPSIS);
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current.length === 0) current = word;
    else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Drops YAML frontmatter so the preview starts at the prose, as Pi does. */
export function skillBody(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (match ? (match[1] ?? '') : content).replace(/^\s+/, '');
}

function matches(skill: SkillEntry, query: string): boolean {
  const needle = query.toLowerCase();
  return skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle);
}

export class SkillsOverlayComponent extends DoomOverlay {
  private readonly options: SkillsOverlayOptions;
  private readonly done: (result: SkillsOverlayResult) => void;
  private readonly readFile: (filePath: string) => string;
  private readonly bodyCache = new Map<string, string[]>();

  /** Index into the skill rows, not into every row: headings are not selectable. */
  private selected = 0;
  private focus: 'tree' | 'body' = 'tree';
  private filtering = false;
  private query = '';
  private bodyOffset = 0;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    options: SkillsOverlayOptions,
    done: (result: SkillsOverlayResult) => void,
  ) {
    super(tui, theme);
    this.options = options;
    this.done = done;
    this.readFile = options.readFile ?? ((filePath) => fs.readFileSync(filePath, 'utf8'));
  }

  /** Every row, honouring the active filter. The tree does not fold. */
  private rows(): TreeRow[] {
    const query = this.query.trim();
    const rows: TreeRow[] = [];
    for (const group of this.options.catalog.groups) {
      const owners = query
        ? group.owners
            .map((owner) => ({ ...owner, skills: owner.skills.filter((skill) => matches(skill, query)) }))
            .filter((owner) => owner.skills.length > 0)
        : group.owners;
      if (owners.length === 0) continue;
      const count = owners.reduce((total, owner) => total + owner.skills.length, 0);
      rows.push({ kind: 'group', depth: 0, label: group.label, tag: String(count) });
      for (const owner of owners) {
        rows.push({ kind: 'owner', depth: 1, label: owner.owner, tag: String(owner.skills.length) });
        for (const skill of owner.skills) {
          rows.push({ kind: 'skill', depth: 2, label: skill.name, tag: '', skill });
        }
      }
    }
    return rows;
  }

  /**
   * Where the skill rows sit in `rows()`.
   *
   * The selection indexes this list rather than `rows()`, which is what keeps
   * headings unselectable without the key handler having to hunt past them, and
   * what puts the opening selection on a skill rather than on the first group.
   */
  private selectable(rows: TreeRow[]): number[] {
    const indexes: number[] = [];
    for (const [index, row] of rows.entries()) if (row.skill) indexes.push(index);
    return indexes;
  }

  private currentRow(): TreeRow | undefined {
    const rows = this.rows();
    const indexes = this.selectable(rows);
    if (indexes.length === 0) return undefined;
    return rows[indexes[Math.min(this.selected, indexes.length - 1)] as number];
  }

  private move(delta: number): void {
    const count = this.selectable(this.rows()).length;
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    this.bodyOffset = 0;
    this.invalidate();
  }

  private bodyLines(skill: SkillEntry, width: number): string[] {
    let raw = this.bodyCache.get(skill.filePath);
    if (!raw) {
      let source: string;
      try {
        source = skillBody(this.readFile(skill.filePath));
      } catch {
        source = UNREADABLE;
      }
      raw = source.split(/\r?\n/);
      this.bodyCache.set(skill.filePath, raw);
    }
    // Wrapped at render width rather than at read time, so a resize reflows the
    // same cached file instead of re-reading it.
    return raw.flatMap((line) => (line.trim() === '' ? [''] : wrap(line, width)));
  }

  handleInput(data: string): void {
    if (this.filtering) {
      this.handleFilterInput(data);
      return;
    }

    if (matchesKey(data, 'escape')) {
      // The filter clears before the overlay closes: escaping straight out of a
      // narrowed tree loses the search with no way to see what it hid.
      if (this.query) {
        this.query = '';
        this.selected = 0;
        this.invalidate();
        return;
      }
      this.done(undefined);
      return;
    }
    if (data === KEY_TAB || matchesKey(data, 'tab')) {
      this.focus = this.focus === 'tree' ? 'body' : 'tree';
      this.invalidate();
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.bodyOffset = Math.max(0, this.bodyOffset - BODY_PAGE);
      this.invalidate();
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.bodyOffset += BODY_PAGE;
      this.invalidate();
      return;
    }
    if (this.focus === 'body') return;

    if (data === FILTER_KEY) {
      this.filtering = true;
      this.invalidate();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
      this.move(1);
      return;
    }

    if (data === KEY_ENTER || data === KEY_NEWLINE || matchesKey(data, 'enter')) {
      const skill = this.currentRow()?.skill;
      if (skill) this.done({ kind: 'invoke', skill });
    }
  }

  private handleFilterInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.filtering = false;
      this.query = '';
      this.selected = 0;
      this.invalidate();
      return;
    }
    if (data === KEY_ENTER || data === KEY_NEWLINE) {
      this.filtering = false;
      this.invalidate();
      return;
    }
    if (data === KEY_BACKSPACE) this.query = this.query.slice(0, -1);
    // Control sequences are dropped rather than appended: an arrow key would
    // otherwise land in the query as a raw escape sequence.
    else if (data.length === 1 && data >= ' ') this.query += data;
    this.selected = 0;
    this.invalidate();
  }

  protected getChrome(): DoomOverlayChrome {
    const { skillCount, promptTokens, bodyTokens } = this.options.catalog;
    const sources = this.options.catalog.groups.filter((group) => group.owners.length > 0).length;
    const hints = this.filtering ? FILTER_HINTS : this.focus === 'body' ? BODY_HINTS : TREE_HINTS;
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      // Two token figures, because they answer different questions: what the
      // catalogue costs on every request, and what reading all of it would cost.
      headerRight: `${skillCount} skills · ${sources} sources · ${formatTokens(promptTokens)} always-on · ${formatTokens(bodyTokens)} full`,
      footer: this.hintLine(hints),
    };
  }

  private badge(text: string, background: ThemeBg, colour: ThemeColor = 'text'): string {
    return this.theme.bg(background, this.theme.fg(colour, ` ${text} `));
  }

  /** Footer hints as capped keys: `[ enter ] use skill`, per the mockup. */
  private hintLine(hints: readonly (readonly [string, string])[]): string {
    return hints
      .map(([key, label]) => `${this.badge(key, 'selectedBg')}${this.theme.fg('dim', ` ${label}`)}`)
      .join(this.theme.fg('dim', '   '));
  }

  protected renderBody(width: number, height: number): string[] {
    if (width < MIN_WIDTH) return this.renderStacked(width, height);

    const treeWidth = Math.max(MIN_PANE_WIDTH, Math.floor((width - 1) * TREE_PANE_RATIO));
    const detailWidth = Math.max(1, width - treeWidth - 1);
    const treeContent = Math.max(1, treeWidth - PANE_GUTTER);
    const detailContent = Math.max(1, detailWidth - PANE_GUTTER);

    const left = this.treeLines(treeContent, height);
    const right = this.detailLines(detailContent, height);
    const divider = this.theme.fg('borderMuted', '│');
    return Array.from({ length: height }, (_, index) => {
      const row = `${fitRow(left[index] ?? '', treeContent)} ${divider} ${fitRow(right[index] ?? '', detailContent)}`;
      return truncateToWidth(row, width, ELLIPSIS);
    });
  }

  private renderStacked(width: number, height: number): string[] {
    const topHeight = Math.max(1, Math.floor((height - 1) / 2));
    const bottomHeight = Math.max(0, height - topHeight - 1);
    const top = this.treeLines(width, topHeight);
    const bottom = this.detailLines(width, bottomHeight);
    return [
      ...top.slice(0, topHeight),
      ...Array.from({ length: Math.max(0, topHeight - top.length) }, () => ''),
      this.theme.fg('borderMuted', RULE.repeat(width)),
      ...bottom.slice(0, bottomHeight),
    ];
  }

  private treeLines(width: number, height: number): string[] {
    const heading = this.filtering || this.query ? `${HEADING}  ${FILTER_KEY}${this.query}` : HEADING;
    const lines = [this.theme.bold(this.theme.fg('accent', heading)), ''];
    const rows = this.rows();
    if (rows.length === 0) {
      lines.push(this.theme.fg('dim', EMPTY_TREE));
      return lines;
    }

    const budget = Math.max(1, height - lines.length);
    const indexes = this.selectable(rows);
    // No skill rows means the filter matched nothing, so nothing is highlighted.
    const selected = indexes[Math.min(this.selected, indexes.length - 1)] ?? -1;
    const start = Math.max(0, Math.min(selected - budget + 1, Math.max(0, rows.length - budget)));
    for (const [offset, row] of rows.slice(start, start + budget).entries()) {
      const isSelected = start + offset === selected;
      const marker = isSelected ? this.theme.fg('accent', SELECTION_MARKER) : ' ';
      const indent = ' '.repeat(row.depth * INDENT);
      // Three tiers rather than two: the group heading leads, the owner beneath
      // it recedes to a caption, and the skills it holds carry the reading
      // weight because they are the only rows that do anything.
      const colour: ThemeColor = row.kind === 'group' ? 'accent' : row.kind === 'owner' ? 'dim' : 'text';
      let label = this.theme.fg(colour, `${indent}${row.label}`);
      if (row.kind === 'group' || isSelected) label = this.theme.bold(label);
      // The tag is capped before it claims columns: an owner in many domains
      // carries a long `+a,b,c` hint that would otherwise leave the name with
      // no room at all and render the row as a bare count.
      const tag = row.tag ? truncateToWidth(row.tag, Math.floor(width * TAG_SHARE), ELLIPSIS) : '';
      const tagWidth = tag ? visibleWidth(tag) + 1 : 0;
      const body = fitRow(`${marker} ${label}`, Math.max(1, width - tagWidth));
      const line = tag ? `${body} ${this.theme.fg('dim', tag)}` : body;
      lines.push(isSelected ? this.theme.bg('selectedBg', fitRow(line, width)) : line);
    }
    return lines;
  }

  private field(label: string, value: string, colour: ThemeColor, width: number): string[] {
    const valueWidth = Math.max(1, width - LABEL_COLUMN);
    return wrap(value, valueWidth).map(
      (line, index) =>
        `${this.theme.fg('dim', fitRow(index === 0 ? label : '', LABEL_COLUMN))}${this.theme.fg(colour, line)}`,
    );
  }

  private detailLines(width: number, height: number): string[] {
    const skill = this.currentRow()?.skill;
    if (!skill) return ['', '', this.theme.fg('dim', NO_SELECTION)];

    const relative = path.relative(this.options.repoRoot, skill.filePath) || skill.filePath;
    const lines = [
      this.theme.bold(this.theme.fg('accent', skill.name)),
      '',
      ...this.field('description', skill.description, 'text', width),
      ...this.field('source', `${skill.group} › ${skill.owner}`, 'success', width),
      ...this.field('path', relative, 'text', width),
      ...this.field(
        'invocable',
        skill.modelInvocable ? `model  ·  /skill:${skill.name}` : `/skill:${skill.name} only`,
        'success',
        width,
      ),
    ];

    const body = this.bodyLines(skill, width);
    const remaining = Math.max(0, height - lines.length - 2);
    // Clamped here rather than in the key handler, because how far the body can
    // scroll depends on the width it has just wrapped to.
    this.bodyOffset = Math.min(this.bodyOffset, Math.max(0, body.length - remaining));
    const shown = body.slice(this.bodyOffset, this.bodyOffset + remaining);
    const position =
      body.length > remaining
        ? `lines ${this.bodyOffset + 1}-${this.bodyOffset + shown.length} / ${body.length}`
        : 'SKILL.md';
    const focus = this.focus === 'body' ? this.theme.fg('accent', ' ◀ focused') : '';

    lines.push('', `${this.theme.fg('dim', position)}${focus}`);
    for (const line of shown) lines.push(this.theme.fg('dim', line));
    return lines;
  }
}

export async function openSkillsOverlay(
  ctx: ExtensionContext,
  options: SkillsOverlayOptions,
): Promise<SkillsOverlayResult> {
  return ctx.ui.custom<SkillsOverlayResult>(
    (tui, theme, _keybindings, done) => new SkillsOverlayComponent(tui, theme, options, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}

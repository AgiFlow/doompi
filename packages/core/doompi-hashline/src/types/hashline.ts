export interface HashlineRangeInput {
  readonly from: string;
  readonly to: string;
  readonly content?: string | null;
}

export interface LineAnchor {
  readonly line: number;
  readonly hash: string;
}

export interface PreparedHashlineEdit {
  readonly from: LineAnchor;
  readonly to: LineAnchor;
  readonly content: string | null;
  readonly source: HashlineRangeInput;
}

export interface AppliedHashlineEdits {
  readonly content: string;
  readonly edits: readonly PreparedHashlineEdit[];
}

export interface FileHeader {
  readonly path: string;
  readonly tag: string;
}

export type TaggedLineMarker = 'match' | 'context';

export interface ParsedTaggedLine {
  readonly content: string;
  readonly line: number;
  readonly marker?: TaggedLineMarker;
}

export type TaggedLinePrefix = '' | '>> ' | '   ';

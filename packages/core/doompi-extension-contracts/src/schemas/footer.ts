import { type Static, Type } from 'typebox';

export const FooterTextColorSchema = Type.Union([
  Type.Literal('accent'),
  Type.Literal('mdCode'),
  Type.Literal('toolDiffAdded'),
  Type.Literal('warning'),
  Type.Literal('mdHeading'),
  Type.Literal('syntaxNumber'),
  Type.Literal('muted'),
  Type.Literal('dim'),
]);
export type FooterTextColor = Static<typeof FooterTextColorSchema>;

export const FooterStatusPlacementSchema = Type.Union([Type.Literal('modeline'), Type.Literal('beforeModel')]);
export type FooterStatusPlacement = Static<typeof FooterStatusPlacementSchema>;

export const FooterTextSegmentSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 80 }),
    color: Type.Optional(FooterTextColorSchema),
  },
  { additionalProperties: false },
);
export type FooterTextSegment = Static<typeof FooterTextSegmentSchema>;

export const FooterStatusItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    fullText: Type.String({ minLength: 1, maxLength: 80 }),
    compactText: Type.String({ minLength: 1, maxLength: 24 }),
    fullSegments: Type.Optional(Type.Array(FooterTextSegmentSchema, { maxItems: 80 })),
    compactSegments: Type.Optional(Type.Array(FooterTextSegmentSchema, { maxItems: 24 })),
    placement: Type.Optional(FooterStatusPlacementSchema),
    order: Type.Integer({ minimum: 0, maximum: 1000 }),
  },
  { additionalProperties: false },
);
export type FooterStatusItem = Static<typeof FooterStatusItemSchema>;

export interface DoomFooterContributionDefinition {
  source: string;
  id: string;
  order: number;
  placement?: FooterStatusPlacement;
}

export interface DoomFooterContributionValue {
  fullText: string;
  compactText: string;
  fullSegments?: FooterTextSegment[];
  compactSegments?: FooterTextSegment[];
}

export interface DoomFooterContributionHandle {
  update(value: DoomFooterContributionValue | undefined): void;
  dispose(): void;
}

export interface DoomFooterStatus extends FooterStatusItem {
  source: string;
}

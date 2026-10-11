import { Type } from 'typebox';

export const ShareFileParameters = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export const SaveFileParameters = Type.Object(
  {
    file: Type.Union([
      Type.Object(
        {
          download_url: Type.String(),
          file_name: Type.String(),
          file_id: Type.Optional(Type.String()),
          mime_type: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object({ name: Type.String(), data_base64: Type.String() }, { additionalProperties: false }),
    ]),
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition.
 *
 * The modules take `currentColor` and the quiet zone is transparent, so each
 * variant sets the surface and the text colour the way a caller has to: a
 * scanner needs the dark modules darker than what surrounds them.
 */
import { QrCode } from './QrCode';

const PAIRING_URL = 'https://doompi-8f21c4.trycloudflare.com/pair#k=7Qb2Xr9LmT4';

const meta = {
  title: 'Web/QrCode',
  component: QrCode,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">scannable · light surface</span>
        <div className="w-fit rounded-md bg-doom-on-selected p-3 text-doom-deep">
          <QrCode value={PAIRING_URL} label="Pairing QR code" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">sizes</span>
        <div className="flex w-fit items-end gap-4 rounded-md bg-doom-on-selected p-3 text-doom-deep">
          <QrCode value={PAIRING_URL} size={72} />
          <QrCode value={PAIRING_URL} size={120} />
          <QrCode value={PAIRING_URL} size={208} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">inherits the theme · dark surface</span>
        <div className="w-fit rounded-md bg-doom-panel p-3 text-doom-hi">
          <QrCode value={PAIRING_URL} size={120} />
        </div>
      </div>
    </div>
  ),
};

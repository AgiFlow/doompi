/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition.
 */
import { MascotMark } from './MascotMark';

const meta = {
  title: 'Web/MascotMark',
  component: MascotMark,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">sizes</span>
        <div className="flex items-end gap-4 text-doom-hi">
          <MascotMark size={20} />
          <MascotMark size={24} />
          <MascotMark size={32} />
          <MascotMark size={48} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">in a lockup</span>
        <div className="flex items-center gap-2 text-doom-hi">
          <span className="text-lg tracking-widest">DOOM</span>
          <MascotMark size={24} />
        </div>
      </div>
    </div>
  ),
};

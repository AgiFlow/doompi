import qrcode from 'qrcode-generator';

/**
 * The one place the QR encoder is touched.
 *
 * Wrapping it keeps the dependency to a single import and hands the renderer a
 * plain boolean grid, so the component stays a pure drawing of data and needs
 * no knowledge of error-correction levels or type numbers.
 */

/**
 * Medium correction: the pairing URL is short, and a phone camera reading a
 * screen has no print noise to recover from, so the extra redundancy of a
 * higher level would only make the modules smaller for no gain.
 */
const ERROR_CORRECTION = 'M';
/** 0 asks the encoder to pick the smallest type number the payload fits in. */
const AUTO_TYPE_NUMBER = 0;

/** Row-major grid of dark modules, including the encoder's own quiet zone handling. */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(AUTO_TYPE_NUMBER, ERROR_CORRECTION);
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const cells: boolean[] = [];
    for (let column = 0; column < size; column += 1) cells.push(code.isDark(row, column));
    rows.push(cells);
  }
  return rows;
}

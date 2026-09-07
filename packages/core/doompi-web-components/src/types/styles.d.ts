/**
 * Stylesheets imported for their side effect.
 *
 * A dependency that ships its own CSS will not lay out without it. The bundler
 * turns this import into a stylesheet; TypeScript only needs to know the
 * module exists.
 */
declare module '*.css' {
  const styles: string;
  export default styles;
}

// Vite resolves `import x from 'foo?url'` to the emitted asset URL string.
// Used by the lazy pdf.js worker import in lib/pdf-raster.ts. (The webapp
// doesn't pull in the full `vite/client` ambient types, so declare just
// the `?url` suffix we use.)
declare module '*?url' {
  const src: string;
  export default src;
}

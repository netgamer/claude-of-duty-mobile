import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * Relative asset URLs: the build is deployed as a static bundle (GitHub Pages
   * project pages, S3, a `dist/` folder opened straight from disk), all of which
   * serve it from a sub-path or from no server root at all. Absolute `/assets/…`
   * URLs break the moment the game is not at the domain root.
   */
  base: './',
  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (OW_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.OW_NO_HMR ? false : undefined,
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});

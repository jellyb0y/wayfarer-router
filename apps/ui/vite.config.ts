import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';

/**
 * Pre-compress the built assets.
 *
 * The interface is served from an SD card over Wi-Fi by a 4×Cortex-A53, and compressing the same
 * bundle on every request is work that can be done once here instead. The daemon serves the
 * pre-compressed files directly; a client that accepts neither encoding still gets the plain file.
 */
function precompress(): Plugin {
  return {
    name: 'wayfarer-precompress',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        const source =
          output.type === 'asset'
            ? typeof output.source === 'string'
              ? Buffer.from(output.source)
              : Buffer.from(output.source)
            : Buffer.from(output.code);
        // Below a kilobyte the compressed form is usually larger and always pointless.
        if (source.length < 1024) continue;
        if (!/\.(js|css|html|svg|json|map)$/.test(fileName)) continue;
        this.emitFile({ type: 'asset', fileName: `${fileName}.gz`, source: gzipSync(source, { level: 9 }) });
        this.emitFile({
          type: 'asset',
          fileName: `${fileName}.br`,
          source: brotliCompressSync(source, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length },
          }),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), precompress()],
  /**
   * A DOM implementation for the tests.
   *
   * These are not browser-driving tests and are not meant to be. They exist so that a screen which
   * mounts today cannot silently stop mounting tomorrow: a React error boundary swallowing a render
   * failure looks like an empty panel and reads as "no data yet", which is exactly the failure that
   * would otherwise be discovered while trying to confirm a revert window.
   */
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  build: {
    outDir: 'dist',
    reportCompressedSize: false,
    sourcemap: false,
  },
  server: {
    proxy: {
      // Development runs the interface on the workstation against a device's API.
      '/api': { target: process.env.WAYFARER_DEV_API ?? 'http://127.0.0.1:8088', changeOrigin: true },
    },
  },
});

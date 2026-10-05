import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * In development Next.js blocks its own client assets when the browser is on a
 * different origin - which is exactly what happens when the app is reached
 * through an ngrok tunnel. The page renders but no JavaScript runs, so nothing
 * on it is clickable. Any host we are reached on has to be listed here.
 */
const tunnelHost = (() => {
  try {
    return new URL(process.env.APP_BASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    ...(tunnelHost && tunnelHost !== 'localhost' ? [tunnelHost] : []),
    ...(process.env.EXTRA_DEV_ORIGINS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
  ],
  output: 'standalone',
  experimental: {
    /**
     * Everything a customer uploads arrives through a server action: scanned
     * policy PDFs and whole monthly attendance registers. The default ceiling
     * is 1 MB, which rejects most of both before a line of our code runs, and
     * does it as a 500 with nothing in it to explain why.
     */
    serverActions: { bodySizeLimit: '25mb' },
  },
  /**
   * Without this Next looks upwards for the project root, finds the enclosing
   * work folder, and writes the standalone build one directory deeper - under a
   * path containing spaces. Pinning it keeps `server.js` at the top of the
   * bundle, which is what App Service starts.
   */
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  /**
   * `pg` has native bindings; the OCR pair is WebAssembly. Neither survives
   * being bundled, so they are required at runtime from node_modules instead.
   */
  serverExternalPackages: ['pg', 'mupdf', 'tesseract.js'],
  /**
   * ...and the tracer has to be told to ship them.
   *
   * `readPdf` reaches mupdf through `await import('mupdf')`, which the tracer
   * cannot follow, and neither library's .wasm payload looks like a dependency
   * to it. Left to itself it builds a bundle where reading a PDF throws
   * MODULE_NOT_FOUND the first time somebody uploads a policy document - which
   * is exactly what it did.
   */
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/mupdf/**',
      './node_modules/tesseract.js/**',
      './node_modules/tesseract.js-core/**',
      // Tesseract does its work in a worker thread it starts by file path, so
      // the tracer never sees that file, let alone what it requires. The first
      // line of it is `require('wasm-feature-detect')`; without these the thread
      // dies on load, and because a failed worker raises no error that
      // tesseract.js listens for, `createWorker` waits for ever. A document sat
      // at "reading" with the CPU idle until this list existed.
      './node_modules/bmp-js/**',
      './node_modules/idb-keyval/**',
      './node_modules/is-url/**',
      './node_modules/node-fetch/**',
      './node_modules/opencollective-postinstall/**',
      './node_modules/regenerator-runtime/**',
      './node_modules/wasm-feature-detect/**',
      './node_modules/zlibjs/**',
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;

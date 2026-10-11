import { defineConfig } from "tsup";

// Three entries, all from one package:
//   "."       browser SDK (ESM + CJS, minified: it ships to every page view)
//   "/react"  ErrorBoundary + useErrorKit; reaches the client through the window
//             global, so it does not bundle a second singleton
//   "/core"   grouping core, shared with apps/api so the server groups errors with
//             exactly the code the SDK runs
//   "/node"   Node server SDK (process handlers, Express/Hono/Fastify, AsyncLocalStorage)
//   "/next"   Next.js onRequestError + withErrorKit; runtime-neutral (Node and edge)
//   global    script-tag IIFE, window.HimetricaErrorKit with data-* auto-init
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    target: "es2020",
  },
  {
    entry: ["src/react/index.tsx"],
    outDir: "dist/react",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    minify: true,
    target: "es2020",
    external: ["react", "react-dom"],
  },
  {
    entry: ["src/core/index.ts"],
    outDir: "dist/core",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
  },
  {
    entry: { index: "src/node/index.ts" },
    outDir: "dist/node",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    platform: "node",
    target: "node18",
  },
  {
    entry: { index: "src/next/index.ts" },
    outDir: "dist/next",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    // Runs in Next's edge runtime too: no node:* allowed, nothing Node-only bundled.
    platform: "neutral",
    target: "es2020",
  },
  {
    entry: { "errorkit.global": "src/global.ts" },
    format: ["iife"],
    minify: true,
    sourcemap: true,
    target: "es2017",
    outExtension: () => ({ js: ".js" }),
  },
]);

// Normalization: turns runtime noise into stable grouping inputs.
//
// The rule of thumb from every tool we studied: anything that changes on a
// deploy (chunk hashes, origins, line/column, cache busters) or per user (ids,
// numbers, emails, urls inside messages) must never reach a hash, or one bug
// becomes a new issue per deploy or per user.

const BUNDLE_ROOTS = [
  "/_next/static/chunks/",
  "/_next/static/",
  "/.next/server/",
  "/.next/",
  "/assets/",
  "/static/js/",
  "/build/",
  "/dist/",
];

/**
 * Stable path for grouping: origin dropped, everything up to a known bundle
 * root dropped, hashes masked in every segment, at most the last 3 segments.
 * `https://x.com/_next/static/chunks/app/(dash)/page-4f2a1b9c8d.js` becomes
 * `app/(dash)/page-<h>.js`.
 */
export function normalizeFile(file: string): string {
  let path = file.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, "");
  path = path.replace(/^webpack:\/\/[^/]*\//, "");
  path = path.replace(/^file:\/\//, "");
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  for (const root of BUNDLE_ROOTS) {
    const i = path.lastIndexOf(root);
    if (i >= 0) {
      path = path.slice(i + root.length);
      break;
    }
  }
  const segments = path.split("/").filter((s) => s && s !== ".");
  return segments.slice(-3).map(maskHashes).join("/").toLowerCase();
}

/** Masks build hashes inside one path segment, keeping words: `index-BxQ3k1aZ.js` -> `index-<h>.js`. */
export function maskHashes(segment: string): string {
  let index = 0;
  return segment.replace(/[A-Za-z0-9]+/g, (token) => (looksLikeHash(token, index++ === 0) ? "<h>" : token));
}

function looksLikeHash(token: string, first: boolean): boolean {
  if (/^[0-9a-f]+$/.test(token) && /[0-9]/.test(token) && /[a-f]/.test(token) && token.length >= (first ? 8 : 6)) {
    return true;
  }
  // A file's leading word is a name (`index`, `page`, `useUser`); only hex hashes lead.
  if (first || token.length < 8) return false;
  const digits = /[0-9]/.test(token);
  const upper = /[A-Z]/.test(token);
  const lower = /[a-z]/.test(token);
  // Vite/Rollup hashes: base64url, mixed case, usually with digits.
  if (digits && (upper || lower)) return true;
  // esbuild hashes: all-caps letters.
  if (upper && !lower) return true;
  // Mixed case without digits: a hash alternates case; camelCase has lowercase runs.
  if (upper && lower && !/[a-z]{3}/.test(token)) return true;
  return false;
}

const NOT_APP = [
  /\/node_modules\//,
  /^node:/,
  /^internal\//,
  /^(chrome|moz|safari|safari-web)-extension:/,
  /^webkit-masked-url:/,
  /^\[native code\]$/,
  /^native$/,
  /^<anonymous>$/,
  /\/next\/dist\//,
  /\/react-dom[.-]/,
];

/**
 * In-app = code the customer wrote. On the browser, a frame from another origin
 * (tag managers, widgets, CDNs) is not in-app either; `appOrigin` is the page origin.
 */
export function isInApp(file: string, appOrigin?: string): boolean {
  if (NOT_APP.some((re) => re.test(file))) return false;
  if (/\/_next\/static\/chunks\/(framework|main|webpack|polyfills)[-.]/.test(file)) return false;
  if (appOrigin && /^https?:\/\//.test(file) && !file.startsWith(appOrigin)) return false;
  return true;
}

/** Frames from browser extensions only: the error is not the customer's. */
export function isExtensionFile(file: string): boolean {
  return /^(chrome|moz|safari|safari-web)-extension:|^webkit-masked-url:/.test(file);
}

// Message parameterization, in the order Sentry applies it (most specific first).
const PARAMS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi, "<url>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  [/\b\d+(?:\.\d+)?(?:ms|s|px|kb|mb|%)?\b/gi, "<n>"],
];

/** Replaces values that vary per user or per request; keeps the words that describe the bug. */
export function parameterize(message: string): string {
  let out = message.trim().slice(0, 1000);
  for (const [re, token] of PARAMS) out = out.replace(re, token);
  // Long or non-identifier quoted text is data; short identifiers ('id') are the bug.
  out = out.replace(/(['"`])([^'"`]{0,200})\1/g, (whole, q: string, inner: string) =>
    /^[\w$.-]{1,40}$/.test(inner) ? whole : `${q}<s>${q}`,
  );
  return out.replace(/\s+/g, " ").slice(0, 200);
}

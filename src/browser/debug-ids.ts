// Debug IDs: which source map belongs to which bundle file.
//
// The build plugin (@himetrica/errorkit-build) prepends to every emitted chunk:
//   globalThis._hmDebugIds[new Error().stack] = "<uuid>"
// The stack of that Error names the chunk's own URL as its top frame, so parsing
// each key gives "file -> debugId" without the build knowing where the file will
// be served from. Vercel and some bundlers expose the same shape as `_debugIds`.
// The server then looks maps up by debugId: no release or filename matching.

import { parseStack } from "../core/stack";
import type { DebugImage, ExceptionValue } from "../core/types";

type IdMap = Record<string, string>;

let cachedKeys = 0;
let cachedByFile: Map<string, string> = new Map();

function sources(): IdMap[] {
  const g = globalThis as unknown as { _hmDebugIds?: IdMap; _debugIds?: IdMap };
  return [g._hmDebugIds, g._debugIds].filter((m): m is IdMap => !!m && typeof m === "object");
}

/** file -> debugId, rebuilt only when chunks were added since the last call. */
export function debugIdsByFile(): Map<string, string> {
  const maps = sources();
  const total = maps.reduce((n, m) => n + Object.keys(m).length, 0);
  if (total === cachedKeys) return cachedByFile;
  const byFile = new Map<string, string>();
  for (const m of maps) {
    for (const [stack, id] of Object.entries(m)) {
      if (typeof id !== "string") continue;
      const top = parseStack(stack).find((f) => /[/:]/.test(f.file));
      if (top && !byFile.has(top.file)) byFile.set(top.file, id);
    }
  }
  cachedKeys = total;
  cachedByFile = byFile;
  return byFile;
}

/** Images for the files this error's frames actually touch (at most 50). */
export function debugImagesFor(exceptions: ExceptionValue[]): DebugImage[] | undefined {
  let byFile: Map<string, string>;
  try {
    byFile = debugIdsByFile();
  } catch {
    return undefined;
  }
  if (byFile.size === 0) return undefined;
  const images: DebugImage[] = [];
  const seen = new Set<string>();
  for (const ex of exceptions) {
    for (const f of ex.frames) {
      if (seen.has(f.file) || images.length >= 50) continue;
      seen.add(f.file);
      const id = byFile.get(f.file);
      if (id) images.push({ type: "sourcemap", codeFile: f.file, debugId: id });
    }
  }
  return images.length > 0 ? images : undefined;
}

/** Test hook: forget the parsed cache. */
export function resetDebugIdCache(): void {
  cachedKeys = 0;
  cachedByFile = new Map();
}

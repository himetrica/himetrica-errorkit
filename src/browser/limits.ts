// Client-side size caps, mirroring the limits the ingest API enforces.
//
// The server truncates too, but it DROPS items whose structure is off and the
// batch caps are hard. Trimming here means the server never has a reason to drop
// one of ours, and the beacon payload stays small.

import type { ErrorEvent, ExceptionValue } from "../core/types";

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_COUNTS_PER_BATCH = 500;
const MAX_EXCEPTIONS = 5;
const MAX_FRAMES = 50;
const MAX_MESSAGE = 2000;
const MAX_TAGS = 50;
const MAX_EXTRA_BYTES = 16 * 1024;

const cut = (s: string | undefined, n: number) => (s === undefined ? undefined : s.slice(0, n));

export function trimException(ex: ExceptionValue): ExceptionValue {
  return {
    type: ex.type.slice(0, 200) || "Error",
    message: ex.message.slice(0, MAX_MESSAGE),
    frames: ex.frames.slice(0, MAX_FRAMES).map((f) => ({
      file: f.file.slice(0, 500),
      function: cut(f.function, 200),
      line: f.line,
      column: f.column,
      inApp: f.inApp,
    })),
  };
}

export function trimEvent(e: ErrorEvent): ErrorEvent {
  const out: ErrorEvent = {
    ...e,
    exceptions: e.exceptions.slice(0, MAX_EXCEPTIONS).map(trimException),
    release: cut(e.release, 200),
    environment: cut(e.environment, 64),
    userId: cut(e.userId, 256),
    url: cut(e.url, 2048),
    customFingerprint: e.customFingerprint?.slice(0, 10).map((p) => p.slice(0, 200)),
  };
  if (e.tags) {
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.tags).slice(0, MAX_TAGS)) tags[k.slice(0, 64)] = String(v).slice(0, 200);
    out.tags = tags;
  }
  if (e.extra) {
    try {
      if (JSON.stringify(e.extra).length > MAX_EXTRA_BYTES) out.extra = { _truncated: true };
    } catch {
      out.extra = undefined;
    }
  }
  return out;
}

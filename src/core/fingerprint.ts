// Two-level grouping, computed identically by the SDK and the server.
//
//   issueKey     loose: canonical type + canonical message + culprit frame.
//                Everything with the same key is one issue (one human title).
//   fingerprint  strict: the above plus the whole in-app call path of every
//                exception in the cause chain. Each fingerprint is a variant
//                inside the issue, the rows you see when the issue expands.
//
// Line and column never enter either hash: they move on every deploy. Minified
// function names (1-2 chars) do not either: they are reassigned per build.
// Bump GROUPING_VERSION whenever an input changes; the server keeps every
// version's fingerprint pointing at the same issue, so nothing splits.

import { explain, type Explained } from "./explain";
import { isInApp, normalizeFile, parameterize } from "./normalize";
import { parseStack } from "./stack";
import type { ExceptionValue, Frame } from "./types";

export const GROUPING_VERSION = 1;

const MAX_HASH_FRAMES = 10;

export interface Grouping {
  fingerprint: string;
  issueKey: string;
  groupingVersion: number;
  /** Throw site the title points at: first in-app frame, else the first frame. */
  culprit?: { file: string; function?: string };
  explained: Explained;
}

export function buildException(
  type: string | undefined,
  message: string | undefined,
  stack: string | undefined,
  appOrigin?: string,
): ExceptionValue {
  const frames: Frame[] = parseStack(stack).map((f) => ({ ...f, inApp: isInApp(f.file, appOrigin) }));
  return { type: type || "Error", message: message ?? "", frames };
}

export function group(exceptions: ExceptionValue[], customFingerprint?: string[]): Grouping {
  const primary = exceptions[0] ?? { type: "Error", message: "", frames: [] };
  const explained = explain(primary.type, primary.message);
  const culpritFrame = primary.frames.find((f) => f.inApp) ?? primary.frames[0];
  const culprit = culpritFrame
    ? { file: normalizeFile(culpritFrame.file), function: usableFunction(culpritFrame.function) }
    : undefined;

  const issueParts = [
    `v${GROUPING_VERSION}`,
    primary.type,
    messageKey(primary, explained),
    culprit ? `${culprit.file}:${culprit.function ?? ""}` : "",
  ];

  let fingerprintParts: string[];
  if (customFingerprint && customFingerprint.length > 0) {
    // `{{default}}` keeps the computed grouping and splits it further.
    const base = exceptions.map(exceptionKey).join("||");
    fingerprintParts = customFingerprint.map((p) => (p === "{{default}}" ? base : p));
  } else {
    fingerprintParts = [`v${GROUPING_VERSION}`, ...exceptions.map(exceptionKey)];
  }

  return {
    fingerprint: hash(fingerprintParts.join("\n")),
    issueKey: hash(issueParts.join("\n")),
    groupingVersion: GROUPING_VERSION,
    culprit,
    explained,
  };
}

function exceptionKey(ex: ExceptionValue): string {
  const explained = explain(ex.type, ex.message);
  const inApp = ex.frames.filter((f) => f.inApp);
  // No in-app frame (vendor-only stack): the full stack is the best signal left.
  const frames = (inApp.length > 0 ? inApp : ex.frames).slice(0, MAX_HASH_FRAMES);
  const path = collapseRecursion(frames.map(frameKey)).join(">");
  return `${ex.type}|${messageKey(ex, explained)}|${path}`;
}

function messageKey(ex: ExceptionValue, explained: Explained): string {
  if (explained.code !== "unknown") {
    const params = Object.keys(explained.params)
      .sort()
      .map((k) => `${k}=${explained.params[k]}`)
      .join(",");
    return `${explained.code}{${params}}`;
  }
  return parameterize(ex.message);
}

function frameKey(f: Frame): string {
  return `${normalizeFile(f.file)}:${usableFunction(f.function) ?? ""}`;
}

/** Minified names are reassigned per build; they would split an issue on every deploy. */
export function usableFunction(fn: string | undefined): string | undefined {
  if (!fn) return undefined;
  const last = fn.split(".").pop() ?? fn;
  return last.length > 2 ? last : undefined;
}

function collapseRecursion(keys: string[]): string[] {
  return keys.filter((k, i) => i === 0 || k !== keys[i - 1]);
}

/**
 * cyrb53 under two seeds: 106 bits as 28 hex chars. Synchronous and dependency
 * free so the browser SDK and Node agree byte for byte; collisions inside one
 * project are not a practical concern at this width.
 */
export function hash(input: string): string {
  return cyrb53(input, 0x9e3779b9) + cyrb53(input, 0x85ebca6b);
}

function cyrb53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

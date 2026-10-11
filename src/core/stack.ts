// Stack string parsing for V8 (Chrome, Edge, Node), SpiderMonkey (Firefox) and
// JavaScriptCore (Safari). Output is ordered throw site first, which is the order
// all three engines print in.
//
// Line and column are kept for display and source-map lookup, never for
// grouping (see fingerprint.ts).

import type { Frame } from "./types";

const MAX_FRAMES = 50;

// V8: "    at fn (file:1:2)", "    at file:1:2", "    at async fn (file:1:2)",
// "    at new Foo (file:1:2)", "    at Object.<anonymous> (file:1:2)".
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?)(?::(\d+))?(?::(\d+))?\)?\s*$/;
// V8 eval frames carry the real location inside: "at eval (eval at fn (file:1:2), <anonymous>:1:3)".
const V8_EVAL = /\(eval at [^(]*\((.+?):(\d+):(\d+)\)/;
// Gecko / JSC: "fn@file:1:2", "@file:1:2", "global code@file:1:2".
const GECKO_FRAME = /^\s*(.*?)@(.+?)(?::(\d+))?(?::(\d+))?\s*$/;

export function parseStack(stack: string | undefined | null): Omit<Frame, "inApp">[] {
  if (!stack) return [];
  const frames: Omit<Frame, "inApp">[] = [];
  for (const raw of stack.split("\n")) {
    if (frames.length >= MAX_FRAMES) break;
    const frame = parseLine(raw);
    if (frame) frames.push(frame);
  }
  return frames;
}

function parseLine(raw: string): Omit<Frame, "inApp"> | null {
  const line = raw.trim();
  if (!line) return null;

  if (line.startsWith("at ")) {
    const evalMatch = V8_EVAL.exec(line);
    const m = V8_FRAME.exec(line);
    if (!m) return null;
    let file = m[2];
    let lineNo = toInt(m[3]);
    let col = toInt(m[4]);
    if (evalMatch) {
      file = evalMatch[1];
      lineNo = toInt(evalMatch[2]);
      col = toInt(evalMatch[3]);
    }
    // "native", "<anonymous>", and V8's builtin markers like "(index 0)" in
    // "at async Promise.all (index 0)" have no location: never in-app.
    if (!/[/:\\]/.test(file)) {
      return { file: file === "<anonymous>" ? file : "native", function: cleanFunction(m[1]) };
    }
    return { file: cleanFile(file), function: cleanFunction(m[1]), line: lineNo, column: col };
  }

  // Gecko / JSC. "[native code]" lines have no "@".
  if (line === "[native code]") return { file: "[native code]" };
  const g = GECKO_FRAME.exec(line);
  if (!g || !g[2]) return null;
  // Firefox eval: "fn@file:1:2 > eval:1:3": the outer location is the useful one.
  const file = g[2].split(" > ")[0];
  return {
    file: cleanFile(file),
    function: cleanFunction(g[1]),
    line: toInt(g[3]),
    column: toInt(g[4]),
  };
}

function toInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function cleanFile(file: string): string {
  // Query strings and hashes carry cache busters and tokens, never location.
  return file.replace(/[?#].*$/, "");
}

/** Strips runtime decoration so the same function reads the same everywhere. */
export function cleanFunction(fn: string | undefined): string | undefined {
  if (!fn) return undefined;
  let name = fn.trim();
  name = name.replace(/^(async|new) /, "");
  name = name.replace(/ \[as [^\]]+\]$/, "");
  // Gecko nests closures as "outer/inner<" or "outer/<".
  name = name.replace(/[/<]+$/, "").split("/").pop() ?? name;
  if (name === "" || name === "<anonymous>" || name === "global code" || name === "eval") return undefined;
  if (name === "Object.<anonymous>") return undefined;
  return name;
}

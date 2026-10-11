// Unit tests for the browser Debug ID registry reader.
//
// Run from packages/errorkit:
//   node --import tsx --test src/browser/debug-ids.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildException } from "../core";
import { debugImagesFor, resetDebugIdCache } from "./debug-ids";

const A = "https://app.acme.com/assets/app-BxQ3k1aZ.js";
const B = "https://app.acme.com/assets/vendor-Zz9Yy8Xx.js";

test("maps the files an error touches to their Debug IDs", () => {
  const g = globalThis as unknown as { _hmDebugIds?: Record<string, string>; _debugIds?: Record<string, string> };
  g._hmDebugIds = { [`Error\n    at ${A}:1:10`]: "1b4e28ba-2fa1-4d3b-a3f5-ef19f0f1a3c1" };
  g._debugIds = { [`@${B}:1:5`]: "2b4e28ba-2fa1-4d3b-a3f5-ef19f0f1a3c2" };
  resetDebugIdCache();
  const ex = [buildException("TypeError", "x", `TypeError: x\n    at loadUser (${A}:1:48211)\n    at e (${B}:1:9)\n    at f (https://cdn.other.com/w.js:1:1)`, "https://app.acme.com")];
  const images = debugImagesFor(ex);
  assert.deepEqual(images, [
    { type: "sourcemap", codeFile: A, debugId: "1b4e28ba-2fa1-4d3b-a3f5-ef19f0f1a3c1" },
    { type: "sourcemap", codeFile: B, debugId: "2b4e28ba-2fa1-4d3b-a3f5-ef19f0f1a3c2" },
  ]);
  delete g._hmDebugIds;
  delete g._debugIds;
  resetDebugIdCache();
  assert.equal(debugImagesFor(ex), undefined, "no registry, no debugMeta");
});

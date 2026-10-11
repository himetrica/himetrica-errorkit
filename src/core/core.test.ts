// Unit tests for the ErrorKit grouping core (pure, no I/O).
//
// Run from packages/errorkit:
//   node --import tsx --test src/core/core.test.ts
//
// What matters here is grouping stability, both ways it can be wrong:
// too strict (one bug -> an issue per deploy / per browser / per user) and too
// loose (unrelated bugs merged under one title).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildException,
  explain,
  group,
  humanTitle,
  normalizeFile,
  parameterize,
  parseStack,
} from "./index";

const CHROME = `TypeError: Cannot read properties of undefined (reading 'id')
    at loadUser (https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js:1:48211)
    at async fetchProfile (https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js:1:50977)
    at Object.r [as onClick] (https://app.acme.com/_next/static/chunks/framework-2c79e2a64abdb08b.js:9:9123)
    at async Promise.all (index 0)`;

const CHROME_NEXT_DEPLOY = CHROME.split("page-4f2a1b9c8d.js:1:48211").join("page-77b2e0aa13.js:1:51102")
  .split("page-4f2a1b9c8d.js:1:50977").join("page-77b2e0aa13.js:1:53880");

const FIREFOX = `loadUser@https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js:1:48230
fetchProfile@https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js:1:50990
r@https://app.acme.com/_next/static/chunks/framework-2c79e2a64abdb08b.js:9:9140`;

const SAFARI = `loadUser@https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js:1:48230
fetchProfile@https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js:1:50990
[native code]`;

const ORIGIN = "https://app.acme.com";

test("parses V8, Gecko and JSC frames, throw site first", () => {
  const v8 = parseStack(CHROME);
  assert.equal(v8[0].function, "loadUser");
  assert.equal(v8[0].line, 1);
  assert.equal(v8[0].column, 48211);
  assert.equal(v8[1].function, "fetchProfile");
  assert.equal(v8[2].function, "Object.r");

  const gecko = parseStack(FIREFOX);
  assert.equal(gecko.length, 3);
  assert.equal(gecko[0].function, "loadUser");
  assert.equal(gecko[0].column, 48230);

  const node = parseStack(`Error: boom
    at handler (/var/task/.next/server/app/api/pay/route.js:12:9)
    at node:internal/process/task_queues:95:5`);
  assert.equal(node[0].file, "/var/task/.next/server/app/api/pay/route.js");
  assert.equal(node[1].file, "node:internal/process/task_queues");
});

test("normalizes bundle paths and masks build hashes", () => {
  assert.equal(
    normalizeFile("https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js"),
    "(dash)/settings/page-<h>.js",
  );
  assert.equal(normalizeFile("https://acme.com/assets/index-BxQ3k1aZ.js"), "index-<h>.js");
  assert.equal(normalizeFile("https://acme.com/assets/chunk-ABCDEFGH.js"), "chunk-<h>.js");
  assert.equal(normalizeFile("https://acme.com/assets/useUserProfile-DkPqRxYz.js"), "useuserprofile-<h>.js");
  assert.equal(normalizeFile("/var/task/.next/server/app/api/pay/route.js"), "api/pay/route.js");
  assert.equal(normalizeFile("webpack-internal:///(rsc)/./src/app/page.tsx"), "src/app/page.tsx");
  // Words are not hashes.
  assert.equal(normalizeFile("https://acme.com/assets/react-dom.production.js"), "react-dom.production.js");
});

test("same bug groups across deploys", () => {
  const a = group([buildException("TypeError", "Cannot read properties of undefined (reading 'id')", CHROME, ORIGIN)]);
  const b = group([
    buildException("TypeError", "Cannot read properties of undefined (reading 'id')", CHROME_NEXT_DEPLOY, ORIGIN),
  ]);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.issueKey, b.issueKey);
});

test("same bug groups across Chrome, Firefox and Safari", () => {
  const chrome = group([buildException("TypeError", "Cannot read properties of undefined (reading 'id')", CHROME, ORIGIN)]);
  const firefox = group([buildException("TypeError", `can't access property "id", user is undefined`, FIREFOX, ORIGIN)]);
  const safari = group([buildException("TypeError", "undefined is not an object (evaluating 'user.id')", SAFARI, ORIGIN)]);
  assert.equal(chrome.issueKey, firefox.issueKey);
  assert.equal(chrome.issueKey, safari.issueKey);
  assert.equal(chrome.fingerprint, firefox.fingerprint);
  assert.equal(chrome.fingerprint, safari.fingerprint);
});

test("different call paths are variants of one issue", () => {
  const fromSettings = group([buildException("TypeError", "Cannot read properties of undefined (reading 'id')", CHROME, ORIGIN)]);
  const fromCheckout = group([
    buildException(
      "TypeError",
      "Cannot read properties of undefined (reading 'id')",
      `TypeError: x
    at loadUser (https://app.acme.com/_next/static/chunks/app/(dash)/settings/page-4f2a1b9c8d.js:1:48211)
    at startCheckout (https://app.acme.com/_next/static/chunks/app/checkout/page-9a8b7c6d5e.js:1:1200)`,
      ORIGIN,
    ),
  ]);
  assert.equal(fromSettings.issueKey, fromCheckout.issueKey);
  assert.notEqual(fromSettings.fingerprint, fromCheckout.fingerprint);
});

test("different messages from the same function stay separate issues", () => {
  const stack = `Error: x
    at submitPayment (https://acme.com/assets/checkout-BxQ3k1aZ.js:1:10)`;
  const a = group([buildException("Error", "Payment failed", stack, "https://acme.com")]);
  const b = group([buildException("Error", "Invalid coupon", stack, "https://acme.com")]);
  assert.notEqual(a.issueKey, b.issueKey);
});

test("per-user values in messages do not split issues", () => {
  const stack = `Error: x
    at loadOrder (https://acme.com/assets/orders-BxQ3k1aZ.js:1:10)`;
  const a = group([buildException("Error", "Order 18233 not found for ana@acme.com", stack, "https://acme.com")]);
  const b = group([buildException("Error", "Order 99102 not found for bob@x.io", stack, "https://acme.com")]);
  assert.equal(a.issueKey, b.issueKey);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(parameterize("Order 18233 not found for ana@acme.com"), "Order <n> not found for <email>");
});

test("minified function names never reach the hash", () => {
  const a = group([buildException("Error", "boom", "Error: boom\n    at e (https://acme.com/assets/index-BxQ3k1aZ.js:1:10)", "https://acme.com")]);
  const b = group([buildException("Error", "boom", "Error: boom\n    at t (https://acme.com/assets/index-Zz9Yy8Xx.js:1:99)", "https://acme.com")]);
  assert.equal(a.fingerprint, b.fingerprint);
});

test("third-party and framework frames are not the culprit", () => {
  const g = group([buildException("TypeError", "Cannot read properties of undefined (reading 'id')", CHROME, ORIGIN)]);
  assert.equal(g.culprit?.function, "loadUser");
  const vendorOnly = group([
    buildException("Error", "boom", "Error: boom\n    at gtm (https://www.googletagmanager.com/gtm.js:1:1)", ORIGIN),
  ]);
  assert.equal(vendorOnly.culprit?.function, "gtm");
});

test("explain maps engine-specific messages to one code", () => {
  assert.deepEqual(explain("TypeError", "Cannot read property 'name' of null"), {
    code: "read_of_nullish",
    params: { prop: "name", value: "null" },
  });
  assert.equal(explain("TypeError", "Failed to fetch").code, "network");
  assert.equal(explain("TypeError", "Load failed").code, "network");
  assert.equal(explain("Error", "Loading chunk 482 failed.").code, "chunk_load");
  assert.equal(explain("TypeError", "Failed to fetch dynamically imported module: https://x/a.js").code, "chunk_load");
  assert.equal(explain("TypeError", "user.getName is not a function").code, "not_a_function");
  assert.deepEqual(explain("ReferenceError", "gtag is not defined").params, { name: "gtag" });
  assert.equal(explain("Error", "Script error.").code, "script_error");
  assert.equal(explain("Error", "Minified React error #418; visit https://react.dev").code, "hydration");
});

test("human titles in en and pt", () => {
  const g = group([buildException("TypeError", "Cannot read properties of undefined (reading 'id')", CHROME, ORIGIN)]);
  const primary = buildException("TypeError", "Cannot read properties of undefined (reading 'id')", CHROME, ORIGIN);
  assert.equal(humanTitle(g, primary, "en"), "Reading 'id' of undefined in loadUser");
  assert.equal(humanTitle(g, primary, "pt"), "Leitura de 'id' em valor indefinido em loadUser");

  const unknown = buildException("Error", "Order 18233 not found", "Error: x\n    at loadOrder (https://acme.com/assets/orders-BxQ3k1aZ.js:1:10)", "https://acme.com");
  assert.equal(humanTitle(group([unknown]), unknown, "pt"), "Error: Order <n> not found em loadOrder");
});

test("custom fingerprint overrides and {{default}} extends", () => {
  const ex = buildException("Error", "boom", "Error: boom\n    at run (https://acme.com/assets/a-BxQ3k1aZ.js:1:1)", "https://acme.com");
  const base = group([ex]);
  assert.equal(group([ex], ["payments"]).fingerprint, group([ex], ["payments"]).fingerprint);
  assert.notEqual(group([ex], ["payments"]).fingerprint, base.fingerprint);
  assert.notEqual(group([ex], ["{{default}}", "tenant-a"]).fingerprint, group([ex], ["{{default}}", "tenant-b"]).fingerprint);
});

// Unit tests for the ErrorKit server SDK (Node + Next entries), no network.
//
// Run from packages/errorkit:
//   node --import tsx --test src/server/server.test.ts
//
// Same cost model as the browser, per process window instead of per session: one
// full event per fingerprint per window, repeats as counters carrying the request's
// visitor/session; the framework helpers capture only 5xx; the key never goes in a URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ErrorBatch } from "../core/types";
import { ServerErrorKit, parseSid, pathOf, shouldCapture, type ServerRuntime } from "./client";
import * as node from "../node/index";
import * as next from "../next/index";

type Sent = { url: string; headers: Record<string, string>; body: ErrorBatch };

function fakeRuntime(statuses: number[] = []) {
  let t = 1_760_000_000_000;
  let id = 0;
  const sent: Sent[] = [];
  const queue = [...statuses];
  const runtime: ServerRuntime = {
    now: () => t,
    uuid: () => `ev-${++id}`,
    random: () => 0.5,
    fetch: async (url, init) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      const status = queue.length > 0 ? queue.shift()! : 202;
      return { status, headers: { get: (n: string) => (n === "Retry-After" ? "30" : null) } };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  return { runtime, sent, advance: (ms: number) => (t += ms) };
}

function serverError(message = "Checkout session cs_123 expired") {
  const e = new Error(message);
  e.stack = `Error: ${message}
    at createCheckout (/var/task/.next/server/app/api/checkout/route.js:12:9)
    at async handler (/var/task/node_modules/next/dist/server/route.js:4:2)`;
  return e;
}

test("first occurrence per window is a full event, repeats are counters with the request visitor", async () => {
  const { runtime, sent, advance } = fakeRuntime();
  const ek = new ServerErrorKit({ secretKey: "hm_sk_test", release: "api@1" }, runtime);
  ek.captureException(serverError(), { scope: { visitorId: "v1", sessionId: "s1", url: "/api/checkout" } });
  for (let i = 0; i < 50; i++) ek.captureException(serverError(), { scope: { visitorId: "v2", sessionId: "s2" } });
  await ek.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.events.length, 1);
  assert.equal(sent[0].body.events[0].platform, "node");
  assert.equal(sent[0].body.events[0].visitorId, "v1");
  assert.equal(sent[0].body.events[0].url, "/api/checkout");
  assert.equal(sent[0].body.counts.length, 1);
  assert.equal(sent[0].body.counts[0].count, 50);
  assert.equal(sent[0].body.counts[0].visitorId, "v2");

  // Next window: the fingerprint sends a full event again.
  advance(3_600_001);
  ek.captureException(serverError());
  await ek.flush();
  assert.equal(sent[1].body.events.length, 1);
});

test("secret key goes in X-API-Key, never in the URL", async () => {
  const { runtime, sent } = fakeRuntime();
  const ek = new ServerErrorKit({ secretKey: "hm_sk_secret", apiUrl: "https://api.example.com/" }, runtime);
  ek.captureException(serverError());
  await ek.flush();
  assert.equal(sent[0].url, "https://api.example.com/api/t/x");
  assert.equal(sent[0].headers["X-API-Key"], "hm_sk_secret");
  assert.equal(sent[0].headers["Content-Type"], "application/json");
});

test("429 pauses and keeps folding; 401 disables", async () => {
  const { runtime, sent } = fakeRuntime([429]);
  const ek = new ServerErrorKit({ secretKey: "hm_sk_x" }, runtime);
  ek.captureException(serverError());
  await ek.flush();
  ek.captureException(serverError());
  await ek.flush();
  assert.equal(sent.length, 1, "no request while paused");
  assert.ok(ek.hasPending());

  const b = fakeRuntime([401]);
  const ek2 = new ServerErrorKit({ secretKey: "hm_sk_x" }, b.runtime);
  ek2.captureException(serverError());
  await ek2.flush();
  assert.equal(ek2.disabled, true);
  ek2.captureException(serverError("other"));
  await ek2.flush();
  assert.equal(b.sent.length, 1);
});

test("node_modules frames are not the culprit; cause chain is kept", async () => {
  const { runtime, sent } = fakeRuntime();
  const ek = new ServerErrorKit({ secretKey: "hm_sk_x" }, runtime);
  const outer = Object.assign(new Error("Payment failed"), { cause: serverError() });
  ek.captureException(outer);
  await ek.flush();
  const ev = sent[0].body.events[0];
  assert.equal(ev.exceptions.length, 2);
  const inner = ev.exceptions[1];
  assert.equal(inner.frames.find((f) => f.inApp)?.function, "createCheckout");
  assert.equal(inner.frames.find((f) => f.file.includes("node_modules"))?.inApp, false);
});

test("helpers: x-hm-sid, path without query, 5xx only", () => {
  assert.deepEqual(parseSid("abc-123.sess-9"), { visitorId: "abc-123", sessionId: "sess-9" });
  assert.deepEqual(parseSid("abc-123."), { visitorId: "abc-123", sessionId: undefined });
  assert.deepEqual(parseSid("<script>.x"), { visitorId: undefined, sessionId: "x" });
  assert.equal(pathOf("https://x.com/api/pay?token=secret#h"), "/api/pay");
  assert.equal(pathOf("/orders/1?x=2"), "/orders/1");
  assert.equal(shouldCapture(new Error("boom")), true);
  assert.equal(shouldCapture(Object.assign(new Error("nope"), { status: 404 })), false);
  assert.equal(shouldCapture(Object.assign(new Error("bad gateway"), { statusCode: 502 })), true);
});

test("express helpers: scope from the request, 4xx skipped, error passed on", async () => {
  const { runtime, sent } = fakeRuntime();
  const ek = node.init({ secretKey: "hm_sk_x", captureUnhandled: false }, runtime)!;
  const req = { method: "POST", originalUrl: "/api/pay?card=4242", route: { path: "/api/pay" }, headers: { "x-hm-sid": "vis-1.ses-1" } };
  let passed: unknown;
  await new Promise<void>((resolve) => {
    node.errorKitExpress.requestHandler()(req, {}, () => {
      node.errorKitExpress.errorHandler()(serverError(), req, {}, (err) => {
        passed = err;
        resolve();
      });
    });
  });
  node.errorKitExpress.errorHandler()(Object.assign(new Error("not found"), { status: 404 }), req, {}, () => {});
  await ek.flush();
  assert.ok(passed instanceof Error);
  assert.equal(sent[0].body.events.length, 1);
  const ev = sent[0].body.events[0];
  assert.equal(ev.visitorId, "vis-1");
  assert.equal(ev.sessionId, "ses-1");
  assert.equal(ev.url, "/api/pay");
  assert.equal(ev.tags?.route, "/api/pay");
  assert.equal(ev.tags?.method, "POST");
  assert.equal(ev.mechanism, "request");
  await node.close();
});

test("captures inside a request scope inherit it (AsyncLocalStorage)", async () => {
  const { runtime, sent } = fakeRuntime();
  const ek = node.init({ secretKey: "hm_sk_x", captureUnhandled: false }, runtime)!;
  await node.withScope({ visitorId: "deep", url: "/jobs" }, async () => {
    await Promise.resolve();
    node.captureException(serverError("deep inside"));
  });
  await ek.flush();
  assert.equal(sent[0].body.events[0].visitorId, "deep");
  await node.close();
});

test("next onRequestError: route context, x-hm-sid, digest as tag, control flow ignored", async () => {
  const { runtime, sent } = fakeRuntime();
  next.register({ secretKey: "hm_sk_x" }, runtime);
  const err = Object.assign(serverError(), { digest: "3241873" });
  await next.onRequestError(
    err,
    { path: "/checkout?step=2", method: "GET", headers: { "x-hm-sid": "v9.s9" } },
    { routerKind: "App Router", routePath: "/checkout", routeType: "render" },
  );
  await next.onRequestError(
    Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }),
    { path: "/", method: "GET", headers: {} },
    { routerKind: "App Router", routePath: "/", routeType: "render" },
  );
  assert.equal(sent.length, 1);
  const ev = sent[0].body.events[0];
  assert.equal(ev.url, "/checkout");
  assert.equal(ev.visitorId, "v9");
  assert.equal(ev.tags?.route, "/checkout");
  assert.equal(ev.tags?.["next.digest"], "3241873");
  assert.equal(ev.tags?.["next.route_type"], "render");
  assert.equal(ev.customFingerprint, undefined);
});

test("next: a generic production message groups by digest", async () => {
  const { runtime, sent } = fakeRuntime();
  (globalThis as unknown as Record<symbol, { client?: unknown }>)[Symbol.for("himetrica.errorkit.next")] = {};
  next.register({ secretKey: "hm_sk_x" }, runtime);
  const generic = "An error occurred in the Server Components render. The specific message is omitted in production builds";
  for (const digest of ["111", "222"]) {
    await next.onRequestError(Object.assign(new Error(generic), { digest }), { path: "/", method: "GET", headers: {} }, { routerKind: "App Router", routePath: "/", routeType: "render" });
  }
  const events = sent.flatMap((s) => s.body.events);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].fingerprint, events[1].fingerprint);
  assert.deepEqual(events[0].customFingerprint, ["next-digest", "111"]);
});

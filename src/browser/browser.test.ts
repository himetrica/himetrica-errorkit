// Unit tests for the ErrorKit browser SDK (no DOM: fake Env with clock, storage, network).
//
// Run from packages/errorkit:
//   node --import tsx --test src/browser/browser.test.ts
//
// What matters is the cost model: one full event per fingerprint per session,
// repeats as counters, budgets that gate only full events, and a transport that
// obeys the status codes instead of hammering the ingest.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ErrorBatch } from "../core/types";
import { ErrorKitClient } from "./client";
import { Collector } from "./collector";
import type { Env } from "./env";
import { readIdentity } from "./identity";
import { splitBodies, Transport } from "./transport";

type Sent = { url: string; body: ErrorBatch };

function fakeEnv(opts: { statuses?: number[]; retryAfter?: string; beacon?: boolean } = {}) {
  let t = 1_760_000_000_000;
  let id = 0;
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const cookies = new Map<string, string>();
  const sent: Sent[] = [];
  const beacons: string[] = [];
  const statuses = [...(opts.statuses ?? [])];
  const env: Env = {
    now: () => t,
    uuid: () => `id-${++id}`,
    random: () => 0.5,
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      const status = statuses.length > 0 ? statuses.shift()! : 202;
      if (status === 0) throw new TypeError("Failed to fetch");
      return { status, headers: { get: (n: string) => (n === "Retry-After" ? opts.retryAfter ?? null : null) } };
    },
    sendBeacon: opts.beacon === false ? undefined : (_url, body) => (beacons.push(body), true),
    getLocal: (k) => local.get(k) ?? null,
    getSession: (k) => session.get(k) ?? null,
    setSession: (k, v) => void session.set(k, v),
    getCookie: (k) => cookies.get(k) ?? null,
    setTimer: () => 0,
    clearTimer: () => {},
  };
  return { env, sent, beacons, local, session, cookies, advance: (ms: number) => (t += ms) };
}

const LOCATION = { origin: "https://app.acme.com", pathname: "/settings" };

function boom(message = "Cannot read properties of undefined (reading 'id')") {
  const e = new TypeError(message);
  e.stack = `TypeError: ${message}
    at loadUser (https://app.acme.com/assets/settings-BxQ3k1aZ.js:1:48211)
    at onClick (https://app.acme.com/assets/settings-BxQ3k1aZ.js:1:50977)`;
  return e;
}

function client(f: ReturnType<typeof fakeEnv>, extra: Partial<ConstructorParameters<typeof ErrorKitClient>[0]> = {}) {
  return new ErrorKitClient({ apiKey: "pk", release: "web@1", ...extra }, f.env, LOCATION);
}

test("first occurrence is a full event, repeats fold into one counter", async () => {
  const f = fakeEnv();
  f.local.set("hm_visitor_id", "v1");
  f.session.set("hm_session_id", "s1");
  const c = client(f);
  for (let i = 0; i < 1000; i++) c.captureThrown(boom(), "onerror");
  await c.flush();
  assert.equal(f.sent.length, 1);
  const body = f.sent[0].body;
  assert.equal(body.events.length, 1);
  assert.equal(body.counts.length, 1);
  assert.equal(body.counts[0].count, 999);
  assert.equal(body.events[0].visitorId, "v1");
  assert.equal(body.events[0].sessionId, "s1");
  assert.equal(body.events[0].url, "https://app.acme.com/settings");
  assert.equal(body.events[0].fingerprint, body.counts[0].fingerprint);
  assert.match(f.sent[0].url, /\/api\/t\/x\?apiKey=pk$/);
});

test("the same error object reported twice counts once", async () => {
  const f = fakeEnv();
  const c = client(f);
  const err = boom();
  c.captureThrown(err, "wrapped");
  c.captureThrown(err, "onerror"); // the wrapper's rethrow reaching window.onerror
  c.captureException(err);
  await c.flush();
  assert.equal(f.sent[0].body.events.length, 1);
  assert.equal(f.sent[0].body.counts.length, 0);
});

test("seen fingerprints survive a page load in the same session, reset on a new one", async () => {
  const f = fakeEnv();
  f.session.set("hm_session_id", "s1");
  const first = client(f);
  first.captureThrown(boom(), "onerror");
  first.flushOnHide();
  assert.equal(f.beacons.length, 1);

  const second = client(f); // next page, same tab session
  second.captureThrown(boom(), "onerror");
  await second.flush();
  assert.equal(f.sent[0].body.events.length, 0);
  assert.equal(f.sent[0].body.counts[0].count, 1);

  f.session.set("hm_session_id", "s2"); // tracker rotated the session
  second.captureThrown(boom(), "onerror");
  await second.flush();
  assert.equal(f.sent[1].body.events.length, 1);
});

test("noise, extension stacks, ignoreErrors and denyUrls never leave the browser", async () => {
  const f = fakeEnv();
  const c = client(f, { ignoreErrors: [/^Payment declined/], denyUrls: ["cdn.thirdparty.com"] });
  c.captureRaw("Script error.");
  c.captureThrown(new Error("ResizeObserver loop completed with undelivered notifications."), "onerror");
  const ext = new Error("x");
  ext.stack = "Error: x\n    at f (chrome-extension://abc/content.js:1:1)";
  c.captureThrown(ext, "onerror");
  c.captureThrown(new Error("Payment declined by bank"), "onerror");
  const third = new Error("y");
  third.stack = "Error: y\n    at g (https://cdn.thirdparty.com/w.js:1:1)";
  c.captureThrown(third, "onerror");
  await c.flush();
  assert.equal(f.sent.length, 0);
});

test("beforeSend null drops the event and its repeats for the session", async () => {
  const f = fakeEnv();
  const c = client(f, { beforeSend: (e) => (e.exceptions[0].message.includes("secret") ? null : e) });
  c.captureException(new Error("secret token leaked"));
  c.captureException(new Error("secret token leaked"));
  c.captureException(new Error("fine"));
  await c.flush();
  assert.equal(f.sent[0].body.events.length, 1);
  assert.equal(f.sent[0].body.events[0].exceptions[0].message, "fine");
  assert.equal(f.sent[0].body.counts.length, 0);
});

test("cause chain is captured up to 5 levels", async () => {
  const f = fakeEnv();
  const c = client(f);
  let err: Error = new Error("root");
  for (let i = 0; i < 8; i++) err = Object.assign(new Error(`wrap ${i}`), { cause: err });
  c.captureException(err);
  await c.flush();
  assert.equal(f.sent[0].body.events[0].exceptions.length, 5);
});

test("per-session cap and token bucket gate full events, never counting", () => {
  let t = 0;
  const col = new Collector(() => t, { maxPerSession: 3, burst: 2, refillMs: 10_000, maxPendingEvents: 100, maxCountKeys: 100 });
  const ev = (fp: string) => ({ fingerprint: fp }) as never;
  assert.equal(col.wantsEvent("a"), true);
  col.pushEvent(ev("a"));
  assert.equal(col.wantsEvent("b"), true);
  col.pushEvent(ev("b"));
  assert.equal(col.wantsEvent("c"), false); // bucket empty
  t += 10_000;
  assert.equal(col.wantsEvent("c"), true);
  col.pushEvent(ev("c"));
  t += 60_000;
  assert.equal(col.wantsEvent("d"), false); // session cap of 3 distinct
  col.pushCount({ fingerprint: "d", groupingVersion: 1, timestamp: t });
  const [batch] = col.drain();
  assert.equal(batch.events.length, 3);
  assert.equal(batch.counts[0].fingerprint, "d");
});

test("429 pauses for Retry-After and keeps folding; the backlog goes out after", async () => {
  const f = fakeEnv({ statuses: [429], retryAfter: "30" });
  const c = client(f);
  c.captureThrown(boom(), "onerror");
  await c.flush();
  assert.equal(f.sent.length, 1);
  for (let i = 0; i < 5; i++) c.captureThrown(boom(), "onerror");
  await c.flush(); // still paused: nothing sent, counters keep folding in memory
  assert.equal(f.sent.length, 1);
  f.advance(31_000);
  await c.flush();
  assert.equal(f.sent.length, 3); // the paused body, then the folded counters
  assert.equal(f.sent[2].body.counts[0].count, 5);
});

test("403 (not in plan) disables the SDK for the page", async () => {
  const f = fakeEnv({ statuses: [403] });
  const c = client(f);
  c.captureThrown(boom(), "onerror");
  await c.flush();
  assert.equal(c.disabled, true);
  c.captureThrown(boom("other"), "onerror");
  await c.flush();
  assert.equal(f.sent.length, 1);
});

test("network failure retries with backoff; 400 drops the body and moves on", async () => {
  const env = fakeEnv({ statuses: [0, 202] });
  const tr = new Transport(env.env, "https://x/api/t/x");
  tr.enqueue([{ events: [], counts: [{ fingerprint: "a", groupingVersion: 1, count: 1, firstTimestamp: 0, lastTimestamp: 0 }] }]);
  assert.equal(await tr.pump(), "retry");
  assert.equal(await tr.pump(), "paused"); // inside backoff window
  env.advance(2_001);
  assert.equal(await tr.pump(), "sent");

  const bad = fakeEnv({ statuses: [400, 202] });
  const tr2 = new Transport(bad.env, "https://x/api/t/x");
  const count = { fingerprint: "a", groupingVersion: 1, count: 1, firstTimestamp: 0, lastTimestamp: 0 };
  tr2.enqueue([{ events: [], counts: [count] }]);
  tr2.enqueue([{ events: [], counts: [{ ...count, fingerprint: "b" }] }]);
  await tr2.pump();
  assert.equal(bad.sent.length, 2);
  assert.equal(tr2.dropped, 1);
  assert.equal(tr2.pending(), 0);
});

test("bodies are split under the beacon limit", () => {
  const counts = Array.from({ length: 500 }, (_, i) => ({
    fingerprint: `fp-${i}-${"x".repeat(40)}`,
    groupingVersion: 1,
    count: 1,
    firstTimestamp: 0,
    lastTimestamp: 0,
    visitorId: "v".repeat(36),
    sessionId: "s".repeat(36),
  }));
  const bodies = splitBodies([{ events: [], counts }], 60_000);
  assert.ok(bodies.length > 1);
  for (const b of bodies) assert.ok(b.length <= 60_000);
  assert.equal(bodies.reduce((n, b) => n + (JSON.parse(b) as ErrorBatch).counts.length, 0), 500);
});

test("identity is read from the tracker's keys, cookies first", () => {
  const f = fakeEnv();
  f.local.set("hm_visitor_id", "local-v");
  f.session.set("hm_session_id", "session-s");
  assert.deepEqual(readIdentity(f.env), { visitorId: "local-v", sessionId: "session-s" });
  f.cookies.set("hm_vid", "cookie-v");
  f.cookies.set("hm_sid", "cookie-s");
  assert.deepEqual(readIdentity(f.env), { visitorId: "cookie-v", sessionId: "cookie-s" });
});

test("sampleRate drops whole occurrences", async () => {
  const f = fakeEnv(); // random() is 0.5
  const c = client(f, { sampleRate: 0.25 });
  c.captureThrown(boom(), "onerror");
  await c.flush();
  assert.equal(f.sent.length, 0);
});

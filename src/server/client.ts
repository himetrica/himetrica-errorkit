// ServerErrorKit: the server side of the fold, runtime-neutral (Node and edge).
//
// Same cost model as the browser, with the process as the unit instead of the
// session: the FIRST occurrence of a fingerprint in a time window (1 h by default)
// goes out as a full event, every later one is folded into a counter. Counters
// carry the request's visitor/session (from x-hm-sid) so a 500 in a loop still
// shows who hit it, at a few bytes per (fingerprint, visitor, session).
//
// Nothing here imports node:*; the Node entry adds AsyncLocalStorage and process
// handlers, the Next entry adds onRequestError. Both pass a scope provider so the
// request context reaches captures made deep inside a handler.

import { buildException, explain, group, GROUPING_VERSION, NOISE_CODES } from "../core";
import type { ErrorEvent, ExceptionValue, Level, Mechanism } from "../core/types";
import { Collector, DEFAULT_COLLECTOR, type CollectorOptions } from "../browser/collector";
import type { Env } from "../browser/env";
import { uuidV4 } from "../browser/env";
import { trimEvent } from "../browser/limits";
import { Transport } from "../browser/transport";

export const SERVER_SDK_VERSION = "0.1.0";

const MAX_CAUSES = 5;

export interface ServerOptions {
  /** Project secret key (hm_sk_...). Sent as X-API-Key, never in a URL. */
  secretKey: string;
  apiUrl?: string;
  release?: string;
  environment?: string;
  /** 0..1, applied per occurrence. Default 1. */
  sampleRate?: number;
  /** Last word on a full event: return null to drop it (and its repeats) for the window. */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null;
  /** Matched against "Type: message" and the message alone. */
  ignoreErrors?: Array<string | RegExp>;
  enabled?: boolean;
  /** Counters flush interval in ms. Default 10000. */
  flushInterval?: number;
  /** A fingerprint sends a full event again after this window. Default 1 h. */
  eventWindowMs?: number;
  /** Distinct fingerprints that get a full event per window. Default 100. */
  maxPerWindow?: number;
}

/** Per-request context, filled by the middlewares / onRequestError. */
export interface RequestScope {
  visitorId?: string;
  sessionId?: string;
  /** Path only: query strings carry tokens. */
  url?: string;
  method?: string;
  route?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface ServerCaptureContext {
  level?: Level;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
  handled?: boolean;
  mechanism?: Mechanism;
  /** Explicit scope; otherwise the provider's (AsyncLocalStorage on Node). */
  scope?: RequestScope;
}

export interface ServerRuntime {
  now(): number;
  uuid(): string;
  random(): number;
  fetch: Env["fetch"];
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export function defaultRuntime(): ServerRuntime {
  return {
    now: () => Date.now(),
    uuid: () => uuidV4(),
    random: () => Math.random(),
    fetch: typeof fetch === "function" ? (fetch.bind(globalThis) as Env["fetch"]) : undefined,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms) as unknown as { unref?: () => void };
      // A pending flush must never keep a Node process alive.
      t?.unref?.();
      return t;
    },
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

export class ServerErrorKit {
  readonly options: ServerOptions;
  private readonly env: Env;
  private readonly collector: Collector;
  private readonly transport: Transport;
  private readonly suppressed = new Set<string>();
  private readonly captured = new WeakSet<object>();
  private windowStart: number;
  private timer: unknown;
  private closed = false;

  constructor(
    options: ServerOptions,
    private readonly runtime: ServerRuntime = defaultRuntime(),
    private readonly scopeProvider: () => RequestScope | undefined = () => undefined,
    readonly sdkName = "himetrica.errorkit.node",
    collectorOptions: Partial<CollectorOptions> = {},
  ) {
    this.options = options;
    this.env = {
      now: runtime.now,
      uuid: runtime.uuid,
      random: runtime.random,
      fetch: runtime.fetch,
      getLocal: () => null,
      getSession: () => null,
      setSession: () => {},
      getCookie: () => null,
      setTimer: runtime.setTimer,
      clearTimer: runtime.clearTimer,
    };
    const apiUrl = (options.apiUrl || "https://app.himetrica.com").replace(/\/+$/, "");
    this.transport = new Transport(this.env, `${apiUrl}/api/t/x`, 20, {
      "Content-Type": "application/json",
      "X-API-Key": options.secretKey,
      "User-Agent": `Himetrica-ErrorKit-Node/${SERVER_SDK_VERSION}`,
    });
    this.collector = new Collector(() => runtime.now(), {
      ...DEFAULT_COLLECTOR,
      maxPerSession: options.maxPerWindow ?? 100,
      burst: 20,
      maxPendingEvents: 200,
      maxCountKeys: 5000,
      ...collectorOptions,
    });
    this.windowStart = runtime.now();
    this.schedule();
  }

  get disabled(): boolean {
    return this.closed || this.options.enabled === false || !this.options.secretKey || this.transport.disabled;
  }

  captureException(error: unknown, ctx: ServerCaptureContext = {}): void {
    if (this.isCaptured(error)) return;
    this.markCaptured(error);
    this.capture(exceptionsFrom(error), { handled: true, mechanism: "manual", ...ctx });
  }

  captureMessage(message: string, level: Level = "info", ctx: ServerCaptureContext = {}): void {
    this.capture([{ type: "Message", message, frames: [] }], { handled: true, mechanism: "manual", ...ctx, level });
  }

  /** Unhandled errors from process handlers and request hooks. */
  captureUnhandled(error: unknown, mechanism: Mechanism, ctx: ServerCaptureContext = {}): void {
    if (this.isCaptured(error)) return;
    this.markCaptured(error);
    this.capture(exceptionsFrom(error), { level: "error", ...ctx, handled: false, mechanism });
  }

  isCaptured(error: unknown): boolean {
    return typeof error === "object" && error !== null && this.captured.has(error);
  }

  markCaptured(error: unknown): void {
    if (typeof error !== "object" || error === null) return;
    try {
      this.captured.add(error);
    } catch {
      // Frozen/exotic objects: worst case counted twice.
    }
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.collector.isEmpty() && !this.transport.isHolding()) this.transport.enqueue(this.collector.drain());
    let timer: unknown;
    const timeout = new Promise<boolean>((resolve) => {
      timer = this.runtime.setTimer(() => resolve(false), timeoutMs);
    });
    const done = this.transport.pump().then(() => true, () => false);
    const ok = await Promise.race([done, timeout]);
    this.runtime.clearTimer(timer);
    return ok;
  }

  async close(timeoutMs = 2000): Promise<boolean> {
    const ok = await this.flush(timeoutMs);
    this.closed = true;
    if (this.timer !== undefined) this.runtime.clearTimer(this.timer);
    return ok;
  }

  /** Anything not yet delivered (folded occurrences or queued bodies). */
  hasPending(): boolean {
    return !this.collector.isEmpty() || this.transport.pending() > 0;
  }

  stats() {
    return { droppedOccurrences: this.collector.dropped, droppedBodies: this.transport.dropped, queued: this.transport.pending() };
  }

  private capture(exceptions: ExceptionValue[], ctx: ServerCaptureContext & { handled: boolean; mechanism: Mechanism }): void {
    if (this.disabled || exceptions.length === 0) return;
    const primary = exceptions[0];
    if (NOISE_CODES.has(explain(primary.type, primary.message).code)) return;
    const text = `${primary.type}: ${primary.message}`;
    if (this.options.ignoreErrors?.some((p) => matches(p, text) || matches(p, primary.message))) return;
    const rate = this.options.sampleRate ?? 1;
    if (rate < 1 && this.runtime.random() >= rate) return;

    this.rotateWindow();
    const grouping = group(exceptions, ctx.fingerprint);
    const fp = grouping.fingerprint;
    if (this.suppressed.has(fp)) return;

    const scope = ctx.scope ?? safeScope(this.scopeProvider);
    const timestamp = this.runtime.now();

    if (this.collector.wantsEvent(fp)) {
      const built = trimEvent({
        eventId: this.runtime.uuid(),
        timestamp,
        platform: "node",
        sdk: { name: this.sdkName, version: SERVER_SDK_VERSION },
        level: ctx.level ?? "error",
        mechanism: ctx.mechanism,
        handled: ctx.handled,
        release: this.options.release,
        environment: this.options.environment,
        exceptions,
        fingerprint: fp,
        groupingVersion: GROUPING_VERSION,
        customFingerprint: ctx.fingerprint,
        visitorId: scope?.visitorId,
        sessionId: scope?.sessionId,
        url: scope?.url,
        tags: { ...scope?.tags, ...(scope?.method ? { method: scope.method } : {}), ...(scope?.route ? { route: scope.route } : {}), ...ctx.tags },
        extra: scope?.extra || ctx.extra ? { ...scope?.extra, ...ctx.extra } : undefined,
      });
      let event: ErrorEvent | null = built;
      if (this.options.beforeSend) {
        try {
          event = this.options.beforeSend(built);
        } catch {
          event = built;
        }
      }
      if (!event) {
        this.suppressed.add(fp);
        this.collector.markSent(fp);
        return;
      }
      this.collector.pushEvent(event);
      return;
    }

    this.collector.pushCount({
      fingerprint: fp,
      groupingVersion: GROUPING_VERSION,
      timestamp,
      release: this.options.release,
      environment: this.options.environment,
      visitorId: scope?.visitorId,
      sessionId: scope?.sessionId,
    });
  }

  /** A long-lived process re-sends one full event per fingerprint per window. */
  private rotateWindow(): void {
    const windowMs = this.options.eventWindowMs ?? 3_600_000;
    const now = this.runtime.now();
    if (now - this.windowStart >= windowMs) {
      this.windowStart = now;
      this.collector.resetSession();
    }
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = this.runtime.setTimer(() => {
      this.flush()
        .catch(() => false)
        .finally(() => this.schedule());
    }, this.options.flushInterval ?? 10_000);
  }
}

/** Error + its `cause` chain (max 5). Server stacks have no origin: in-app = not node_modules / node:. */
export function exceptionsFrom(error: unknown): ExceptionValue[] {
  const out: ExceptionValue[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && out.length < MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error || (typeof current === "object" && "message" in (current as object))) {
      const e = current as Error;
      out.push(buildException(e.name || "Error", String(e.message ?? ""), typeof e.stack === "string" ? e.stack : undefined));
      current = (e as Error & { cause?: unknown }).cause;
    } else {
      out.push({ type: "Error", message: stringify(current), frames: [] });
      current = undefined;
    }
  }
  return out;
}

/** `x-hm-sid: <visitorId>.<sessionId>`, written by the browser SDK on same-origin fetches. */
export function parseSid(header: string | null | undefined): { visitorId?: string; sessionId?: string } {
  if (!header) return {};
  const value = header.trim().slice(0, 300);
  const dot = value.indexOf(".");
  const visitorId = (dot >= 0 ? value.slice(0, dot) : value).slice(0, 128);
  const sessionId = dot >= 0 ? value.slice(dot + 1).slice(0, 128) : "";
  const clean = (s: string) => (/^[\w-]+$/.test(s) ? s : undefined);
  return { visitorId: clean(visitorId), sessionId: clean(sessionId) };
}

/** 5xx or no status at all: the only errors worth an issue (a 404 is not a bug). */
export function shouldCapture(error: unknown): boolean {
  const e = error as { status?: unknown; statusCode?: unknown; status_code?: unknown; output?: { statusCode?: unknown } } | null;
  const raw = e?.status ?? e?.statusCode ?? e?.status_code ?? e?.output?.statusCode;
  const status = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : undefined;
  return status === undefined || !Number.isFinite(status) || status >= 500;
}

/** Path only; accepts absolute URLs and request paths. */
export function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.search(/[?#]/);
  const noQuery = q >= 0 ? url.slice(0, q) : url;
  return noQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").slice(0, 2048) || "/";
}

function safeScope(provider: () => RequestScope | undefined): RequestScope | undefined {
  try {
    return provider();
  } catch {
    return undefined;
  }
}

function matches(pattern: string | RegExp, value: string): boolean {
  return typeof pattern === "string" ? value.includes(pattern) : pattern.test(value);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

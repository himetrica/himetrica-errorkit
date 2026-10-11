// ErrorKitClient: turns a thrown value into either a full event or a counter.
//
// Pipeline per occurrence, cheapest checks first:
//   1. build the exception chain (error + `cause`, up to 5) with the shared core;
//   2. noise: Script error / ResizeObserver, extension-only stacks, ignoreErrors,
//      denyUrls, fingerprints a beforeSend already rejected;
//   3. sampleRate;
//   4. group() -> fingerprint, the same function the server runs;
//   5. the fold (collector.ts): first in the session -> full event (after
//      beforeSend), otherwise a counter.
// Flushes every 5 s, and through sendBeacon when the page is hidden.

import { buildException, group, explain, NOISE_CODES, isExtensionFile, GROUPING_VERSION } from "../core";
import type { ErrorEvent, ExceptionValue, Level, Mechanism } from "../core/types";
import { Collector, DEFAULT_COLLECTOR, type CollectorOptions } from "./collector";
import type { Env } from "./env";
import { readIdentity } from "./identity";
import { trimEvent } from "./limits";
import { Transport } from "./transport";
import { debugImagesFor } from "./debug-ids";

function debugMetaFor(exceptions: ExceptionValue[]): ErrorEvent["debugMeta"] {
  const images = debugImagesFor(exceptions);
  return images ? { images } : undefined;
}

export const SDK_NAME = "himetrica.errorkit.browser";
export const SDK_VERSION = "0.1.0";

const SEEN_KEY = "hm_ek_seen";
const PAGE_SESSION_KEY = "hm_ek_sid";
const MAX_CAUSES = 5;

export interface ErrorKitOptions {
  apiKey: string;
  apiUrl?: string;
  release?: string;
  environment?: string;
  /** 0..1, applied per occurrence. Default 1. */
  sampleRate?: number;
  /** Last word on a full event: return null to drop it (and its repeats) for this session. */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null;
  /** Matched against "Type: message" and the message alone. */
  ignoreErrors?: Array<string | RegExp>;
  /** Matched against the file of the throwing frame. */
  denyUrls?: Array<string | RegExp>;
  enabled?: boolean;
  /** Distinct fingerprints per session that get a full event. Default 20. */
  maxPerSession?: number;
  /** Capture console.error calls. Default false. */
  captureConsole?: boolean;
  /** Wrap setTimeout/setInterval/requestAnimationFrame/addEventListener for real stacks. Default true. */
  wrapBrowserApis?: boolean;
  /** Add `x-hm-sid` to same-origin fetches so server errors join the visitor. Default true. */
  propagateSession?: boolean;
  /** Respect Do Not Track / Global Privacy Control. Default false. */
  respectDNT?: boolean;
  /** Run on localhost (off by default, like the tracker). */
  allowLocalhost?: boolean;
  /** Keep Script error / ResizeObserver noise. Default false. */
  keepNoise?: boolean;
  /** Flush interval in ms. Default 5000. */
  flushInterval?: number;
}

export interface CaptureContext {
  level?: Level;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
  handled?: boolean;
  mechanism?: Mechanism;
}

export class ErrorKitClient {
  readonly options: ErrorKitOptions;
  private readonly collector: Collector;
  private readonly transport: Transport;
  private readonly suppressed = new Set<string>();
  /**
   * Error objects already reported. Lives on the client (not in a module) so every
   * bundle that reaches it (the React boundary is its own bundle) shares it: React
   * rethrows boundary errors to window.onerror in development, and a wrapped callback
   * rethrows by design; neither may count twice.
   */
  private readonly captured = new WeakSet<object>();
  private readonly tags: Record<string, string> = {};
  private userId?: string;
  private sessionKey: string;
  private timer: unknown;
  private closed = false;

  constructor(
    options: ErrorKitOptions,
    private readonly env: Env,
    private readonly location: { origin: string; pathname: string } | undefined,
    collectorOptions: Partial<CollectorOptions> = {},
  ) {
    this.options = options;
    const apiUrl = (options.apiUrl || "https://app.himetrica.com").replace(/\/+$/, "");
    this.transport = new Transport(env, `${apiUrl}/api/t/x?apiKey=${encodeURIComponent(options.apiKey)}`);
    this.sessionKey = this.currentSessionKey();
    this.collector = new Collector(
      () => env.now(),
      { ...DEFAULT_COLLECTOR, maxPerSession: options.maxPerSession ?? DEFAULT_COLLECTOR.maxPerSession, ...collectorOptions },
      this.loadSeen(this.sessionKey),
    );
    this.schedule();
  }

  get disabled(): boolean {
    return this.closed || this.options.enabled === false || this.transport.disabled;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = value;
  }

  setUser(user: { id?: string } | null): void {
    this.userId = user?.id || undefined;
  }

  captureException(error: unknown, ctx: CaptureContext = {}): void {
    if (this.isCaptured(error)) return;
    this.markCaptured(error);
    this.capture(this.exceptionsFrom(error), { handled: true, mechanism: "manual", ...ctx });
  }

  isCaptured(error: unknown): boolean {
    return typeof error === "object" && error !== null && this.captured.has(error);
  }

  markCaptured(error: unknown): void {
    if (typeof error !== "object" || error === null) return;
    try {
      this.captured.add(error);
    } catch {
      // Exotic objects: worst case the error is counted twice.
    }
  }

  captureMessage(message: string, level: Level = "info"): void {
    this.capture([{ type: "Message", message, frames: [] }], { level, handled: true, mechanism: "manual" });
  }

  /** For global handlers: an error value thrown somewhere. */
  captureThrown(error: unknown, mechanism: Mechanism, extra?: Record<string, unknown>): void {
    if (this.isCaptured(error)) return;
    this.markCaptured(error);
    this.capture(this.exceptionsFrom(error), { handled: false, mechanism, level: "error", extra });
  }

  /** For window.onerror without an Error object (old browsers, cross-origin). */
  captureRaw(message: string, file?: string, line?: number, column?: number): void {
    const match = /^(?:Uncaught )?(\w*Error)\s*:\s*(.*)$/s.exec(message);
    const ex: ExceptionValue = {
      type: match?.[1] || "Error",
      message: match?.[2] ?? message,
      frames: file ? [{ file, line, column, inApp: true }] : [],
    };
    this.capture([ex], { handled: false, mechanism: "onerror", level: "error" });
  }

  async flush(): Promise<void> {
    if (!this.collector.isEmpty() && !this.transport.isHolding()) this.transport.enqueue(this.collector.drain());
    await this.transport.pump();
  }

  /** Page hidden or unloading: everything goes out through sendBeacon. */
  flushOnHide(): void {
    this.persistSeen();
    if (this.transport.disabled) return;
    this.transport.flushOnHide(this.collector.isEmpty() ? [] : this.collector.drain());
  }

  close(): void {
    this.flushOnHide();
    this.closed = true;
    if (this.timer !== undefined) this.env.clearTimer(this.timer);
  }

  /** Exposed for tests and debugging. */
  stats() {
    return { droppedOccurrences: this.collector.dropped, droppedBodies: this.transport.dropped, queued: this.transport.pending() };
  }

  private capture(exceptions: ExceptionValue[], ctx: CaptureContext & { handled: boolean; mechanism: Mechanism }): void {
    if (this.disabled || exceptions.length === 0) return;
    const primary = exceptions[0];
    if (this.isNoise(primary)) return;
    const rate = this.options.sampleRate ?? 1;
    if (rate < 1 && this.env.random() >= rate) return;

    const grouping = group(exceptions, ctx.fingerprint);
    const fp = grouping.fingerprint;
    if (this.suppressed.has(fp)) return;

    this.syncSession();
    const { visitorId, sessionId } = readIdentity(this.env);
    const timestamp = this.env.now();

    if (this.collector.wantsEvent(fp)) {
      const built: ErrorEvent = trimEvent({
        eventId: this.env.uuid(),
        timestamp,
        platform: "browser",
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        level: ctx.level ?? "error",
        mechanism: ctx.mechanism,
        handled: ctx.handled,
        release: this.options.release,
        environment: this.options.environment,
        exceptions,
        fingerprint: fp,
        groupingVersion: GROUPING_VERSION,
        customFingerprint: ctx.fingerprint,
        visitorId,
        sessionId,
        userId: this.userId,
        // Query strings carry tokens and ids; the path is what locates the error.
        url: this.location ? this.location.origin + this.location.pathname : undefined,
        tags: { ...this.tags, ...ctx.tags },
        extra: ctx.extra,
        debugMeta: debugMetaFor(exceptions),
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
      this.persistSeen();
      return;
    }

    this.collector.pushCount({
      fingerprint: fp,
      groupingVersion: GROUPING_VERSION,
      timestamp,
      release: this.options.release,
      environment: this.options.environment,
      visitorId,
      sessionId,
    });
  }

  private exceptionsFrom(error: unknown): ExceptionValue[] {
    const origin = this.location?.origin;
    const out: ExceptionValue[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && current !== null && out.length < MAX_CAUSES && !seen.has(current)) {
      seen.add(current);
      if (current instanceof Error || (typeof current === "object" && "message" in (current as object))) {
        const e = current as Error;
        out.push(buildException(e.name || "Error", String(e.message ?? ""), typeof e.stack === "string" ? e.stack : undefined, origin));
        current = (e as Error & { cause?: unknown }).cause;
      } else {
        out.push({ type: "Error", message: safeString(current), frames: [] });
        current = undefined;
      }
    }
    return out;
  }

  private isNoise(primary: ExceptionValue): boolean {
    if (!this.options.keepNoise && NOISE_CODES.has(explain(primary.type, primary.message).code)) return true;
    if (primary.frames.length > 0 && primary.frames.every((f) => isExtensionFile(f.file))) return true;
    const text = `${primary.type}: ${primary.message}`;
    if (this.options.ignoreErrors?.some((p) => matches(p, text) || matches(p, primary.message))) return true;
    const top = primary.frames[0]?.file;
    if (top && this.options.denyUrls?.some((p) => matches(p, top))) return true;
    return false;
  }

  /** The fold is per session; the tracker's session if present, else one per tab. */
  private currentSessionKey(): string {
    const { sessionId } = readIdentity(this.env);
    if (sessionId) return sessionId;
    let own = this.env.getSession(PAGE_SESSION_KEY);
    if (!own) {
      own = this.env.uuid();
      this.env.setSession(PAGE_SESSION_KEY, own);
    }
    return own;
  }

  private syncSession(): void {
    const key = this.currentSessionKey();
    if (key !== this.sessionKey) {
      this.sessionKey = key;
      this.collector.resetSession(this.loadSeen(key));
    }
  }

  /** Seen fingerprints survive full page navigations within the session (MPA sites). */
  private loadSeen(sessionKey: string): string[] {
    try {
      const raw = this.env.getSession(SEEN_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { s?: string; f?: string[] };
      return parsed.s === sessionKey && Array.isArray(parsed.f) ? parsed.f.slice(0, 200) : [];
    } catch {
      return [];
    }
  }

  private persistSeen(): void {
    this.env.setSession(SEEN_KEY, JSON.stringify({ s: this.sessionKey, f: this.collector.seenFingerprints().slice(0, 200) }));
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = this.env.setTimer(() => {
      this.flush()
        .catch(() => {})
        .finally(() => this.schedule());
    }, this.options.flushInterval ?? 5000);
  }
}

function matches(pattern: string | RegExp, value: string): boolean {
  return typeof pattern === "string" ? value.includes(pattern) : pattern.test(value);
}

export function safeString(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

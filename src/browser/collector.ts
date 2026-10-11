// The fold: what makes ErrorKit cheap.
//
// Per session, the FIRST occurrence of a fingerprint is sent as a full event;
// every later one is folded into a counter `{fingerprint, count, first, last}`
// that rides the next flush. A render loop throwing 10k times costs one event and
// one counter. Dedupe happens here, BEFORE any rate limit, so repeats never burn
// the budget that new errors need.
//
// Two budgets only gate FULL events, never counting (the quota is by error count,
// and a counter is a few bytes):
//   - maxPerSession distinct fingerprints get a full event; past that, counters only;
//   - a token bucket (burst 10, +1 every 10 s) smooths a burst of many distinct
//     errors; a fingerprint that misses a token is counted now and gets its full
//     event on a later occurrence, when tokens are back.
// Counters for a fingerprint the server never saw in full are not lost: ClickHouse
// keeps them by fingerprint and they join the issue as soon as any session sends it.

import type { ErrorBatch, ErrorCount, ErrorEvent } from "../core/types";
import { MAX_COUNTS_PER_BATCH, MAX_EVENTS_PER_BATCH } from "./limits";

export interface CollectorOptions {
  maxPerSession: number;
  burst: number;
  refillMs: number;
  /** Pending full events kept in memory (paused or offline). */
  maxPendingEvents: number;
  /** Distinct counter rows kept in memory. */
  maxCountKeys: number;
}

export const DEFAULT_COLLECTOR: CollectorOptions = {
  maxPerSession: 20,
  burst: 10,
  refillMs: 10_000,
  maxPendingEvents: 100,
  maxCountKeys: 1000,
};

export interface CountContext {
  fingerprint: string;
  groupingVersion: number;
  timestamp: number;
  release?: string;
  environment?: string;
  visitorId?: string;
  sessionId?: string;
}

export class Collector {
  private sent: Set<string>;
  private events: ErrorEvent[] = [];
  private counts = new Map<string, ErrorCount>();
  private tokens: number;
  private lastRefill: number;
  /** Occurrences lost to memory caps; reported for debugging, never sent. */
  dropped = 0;

  constructor(
    private readonly now: () => number,
    private readonly opts: CollectorOptions = DEFAULT_COLLECTOR,
    seen: Iterable<string> = [],
  ) {
    this.sent = new Set(seen);
    this.tokens = opts.burst;
    this.lastRefill = now();
  }

  /** Session rotated: the fold starts over (each session sends its first occurrence). */
  resetSession(seen: Iterable<string> = []): void {
    this.sent = new Set(seen);
  }

  seenFingerprints(): string[] {
    return Array.from(this.sent);
  }

  /** Would this fingerprint's occurrence go out as a full event right now? Does not consume. */
  wantsEvent(fingerprint: string): boolean {
    if (this.sent.has(fingerprint)) return false;
    if (this.sent.size >= this.opts.maxPerSession) return false;
    if (this.events.length >= this.opts.maxPendingEvents) return false;
    this.refill();
    return this.tokens >= 1;
  }

  /** Call only after wantsEvent() returned true. */
  pushEvent(event: ErrorEvent): void {
    this.refill();
    this.tokens -= 1;
    this.sent.add(event.fingerprint);
    this.events.push(event);
  }

  /** Mark a fingerprint as handled for the session without sending (beforeSend dropped it). */
  markSent(fingerprint: string): void {
    this.sent.add(fingerprint);
  }

  pushCount(ctx: CountContext, n = 1): void {
    const key = [ctx.fingerprint, ctx.release ?? "", ctx.environment ?? "", ctx.visitorId ?? "", ctx.sessionId ?? ""].join("|");
    const existing = this.counts.get(key);
    if (existing) {
      existing.count += n;
      existing.firstTimestamp = Math.min(existing.firstTimestamp, ctx.timestamp);
      existing.lastTimestamp = Math.max(existing.lastTimestamp, ctx.timestamp);
      return;
    }
    if (this.counts.size >= this.opts.maxCountKeys) {
      this.dropped += n;
      return;
    }
    this.counts.set(key, {
      fingerprint: ctx.fingerprint,
      groupingVersion: ctx.groupingVersion,
      count: n,
      firstTimestamp: ctx.timestamp,
      lastTimestamp: ctx.timestamp,
      release: ctx.release,
      environment: ctx.environment,
      visitorId: ctx.visitorId,
      sessionId: ctx.sessionId,
    });
  }

  isEmpty(): boolean {
    return this.events.length === 0 && this.counts.size === 0;
  }

  /** Takes everything pending, split into batches the server accepts. */
  drain(): ErrorBatch[] {
    const batches: ErrorBatch[] = [];
    const counts = Array.from(this.counts.values());
    const events = this.events;
    this.events = [];
    this.counts.clear();
    let ei = 0;
    let ci = 0;
    while (ei < events.length || ci < counts.length) {
      batches.push({
        events: events.slice(ei, ei + MAX_EVENTS_PER_BATCH),
        counts: counts.slice(ci, ci + MAX_COUNTS_PER_BATCH),
      });
      ei += MAX_EVENTS_PER_BATCH;
      ci += MAX_COUNTS_PER_BATCH;
    }
    return batches;
  }

  private refill(): void {
    const now = this.now();
    const gained = Math.floor((now - this.lastRefill) / this.opts.refillMs);
    if (gained > 0) {
      this.tokens = Math.min(this.opts.burst, this.tokens + gained);
      this.lastRefill += gained * this.opts.refillMs;
    }
  }
}

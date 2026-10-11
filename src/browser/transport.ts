// Transport: batches to POST {apiUrl}/api/t/x?apiKey=..., reading the status codes
// the ingest returns (the v1 endpoint answered 204 to everything, so no SDK could
// react to anything).
//
//   2xx      sent
//   429      pause for Retry-After; the client keeps folding in memory meanwhile
//   401/403  bad key, origin not allowed, or ErrorKit not in the plan: stop for this page
//   400/413  this body is unusable: drop it, keep going
//   5xx/net  keep it, retry with exponential backoff
//
// Bodies are sent as text/plain with the key in the query string: a "simple"
// CORS request, so no preflight per flush. On page hide the queue goes out through
// sendBeacon in chunks under the 64 KB keepalive limit.

import type { ErrorBatch } from "../core/types";
import type { Env } from "./env";

const BEACON_MAX_BYTES = 60_000;
const FETCH_MAX_BYTES = 512_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 2_000;

export type SendOutcome = "sent" | "paused" | "disabled" | "dropped" | "retry" | "idle";

export class Transport {
  private queue: string[] = [];
  private pausedUntil = 0;
  private backoffUntil = 0;
  private failures = 0;
  private sending = false;
  disabled = false;
  /** Bodies dropped (unusable, or queue overflow). */
  dropped = 0;

  constructor(
    private readonly env: Env,
    private readonly url: string,
    private readonly maxQueued = 10,
    /** Browser: text/plain, key in the query (no preflight). Server: JSON + X-API-Key. */
    private readonly headers: Record<string, string> = { "Content-Type": "text/plain" },
  ) {}

  /** True while the server asked us to wait: the client should keep folding instead of draining. */
  isHolding(): boolean {
    const now = this.env.now();
    return this.disabled || now < this.pausedUntil || now < this.backoffUntil;
  }

  enqueue(batches: ErrorBatch[]): void {
    if (this.disabled) return;
    for (const body of splitBodies(batches, FETCH_MAX_BYTES)) {
      this.queue.push(body);
      if (this.queue.length > this.maxQueued) {
        this.queue.shift();
        this.dropped++;
      }
    }
  }

  /** Sends queued bodies in order until one does not go through. */
  async pump(): Promise<SendOutcome> {
    if (this.sending) return "idle";
    if (!this.env.fetch) return "idle";
    this.sending = true;
    try {
      let last: SendOutcome = "idle";
      while (this.queue.length > 0) {
        if (this.disabled) return "disabled";
        if (this.isHolding()) return "paused";
        last = await this.sendOne(this.queue[0]);
        if (last === "sent" || last === "dropped") {
          this.queue.shift();
          continue;
        }
        return last;
      }
      return last;
    } finally {
      this.sending = false;
    }
  }

  /** Page is going away: everything queued goes out through sendBeacon, fetch keepalive as fallback. */
  flushOnHide(batches: ErrorBatch[]): void {
    if (this.disabled) return;
    const bodies = [...this.queue, ...splitBodies(batches, BEACON_MAX_BYTES)];
    this.queue = [];
    for (const body of bodies) {
      const chunks = body.length > BEACON_MAX_BYTES ? splitBodies([JSON.parse(body) as ErrorBatch], BEACON_MAX_BYTES) : [body];
      for (const chunk of chunks) {
        if (this.env.sendBeacon && this.env.sendBeacon(this.url, chunk)) continue;
        this.env.fetch?.(this.url, { method: "POST", body: chunk, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
      }
    }
  }

  pending(): number {
    return this.queue.length;
  }

  private async sendOne(body: string): Promise<SendOutcome> {
    let status: number;
    let retryAfter: string | null = null;
    try {
      const res = await this.env.fetch!(this.url, { method: "POST", body, headers: this.headers });
      status = res.status;
      retryAfter = res.headers.get("Retry-After");
    } catch {
      return this.fail();
    }

    if (status >= 200 && status < 300) {
      this.failures = 0;
      return "sent";
    }
    if (status === 429) {
      const seconds = Number(retryAfter);
      this.pausedUntil = this.env.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
      return "paused";
    }
    if (status === 401 || status === 403) {
      this.disabled = true;
      this.queue = [];
      return "disabled";
    }
    if (status >= 400 && status < 500) {
      this.dropped++;
      return "dropped";
    }
    return this.fail();
  }

  private fail(): SendOutcome {
    this.failures++;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failures - 1));
    this.backoffUntil = this.env.now() + delay;
    return "retry";
  }
}

/**
 * Serializes batches into bodies no larger than maxBytes, splitting a batch item by
 * item when needed. A single item over the limit is sent with its frames trimmed
 * rather than dropped.
 */
export function splitBodies(batches: ErrorBatch[], maxBytes: number): string[] {
  const out: string[] = [];
  for (const batch of batches) {
    const whole = JSON.stringify(batch);
    if (whole.length <= maxBytes) {
      if (batch.events.length > 0 || batch.counts.length > 0) out.push(whole);
      continue;
    }
    let current: ErrorBatch = { events: [], counts: [] };
    let size = 24;
    const push = () => {
      if (current.events.length > 0 || current.counts.length > 0) out.push(JSON.stringify(current));
      current = { events: [], counts: [] };
      size = 24;
    };
    for (const e of batch.events) {
      let item = e;
      let len = JSON.stringify(item).length + 1;
      if (len > maxBytes - 24) {
        item = { ...e, extra: undefined, exceptions: e.exceptions.map((x) => ({ ...x, frames: x.frames.slice(0, 10) })) };
        len = JSON.stringify(item).length + 1;
      }
      if (size + len > maxBytes) push();
      current.events.push(item);
      size += len;
    }
    for (const ct of batch.counts) {
      const len = JSON.stringify(ct).length + 1;
      if (size + len > maxBytes) push();
      current.counts.push(ct);
      size += len;
    }
    push();
  }
  return out;
}

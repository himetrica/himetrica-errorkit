// @himetrica/errorkit/node: Himetrica ErrorKit for Node servers.
//
//   import { init, errorKitExpress } from "@himetrica/errorkit/node";
//   init({ secretKey: process.env.HIMETRICA_SECRET_KEY!, release: "api@1.42.0" });
//   app.use(errorKitExpress.requestHandler());   // first
//   ...routes...
//   app.use(errorKitExpress.errorHandler());     // after the routes
//
// Request scope lives in AsyncLocalStorage, so a captureException deep inside a
// handler still carries the request path, method, route and the visitor/session
// the browser SDK sent in x-hm-sid. Only 5xx (or errors without a status) are
// captured by the framework helpers: a 404 is not a bug.
//
// Process handlers follow Node's own semantics:
//   uncaughtException: capture, flush (bounded), then exit(1), unless the app has
//     its own listener (then the app decides, as Node would have let it).
//   unhandledRejection: "warn" (default) captures and lets the process live, like
//     Node's --unhandled-rejections=warn; "strict" captures, flushes and exits(1).

import { AsyncLocalStorage } from "node:async_hooks";
import type { Level } from "../core/types";
import {
  ServerErrorKit,
  defaultRuntime,
  parseSid,
  pathOf,
  shouldCapture,
  type RequestScope,
  type ServerCaptureContext,
  type ServerOptions,
  type ServerRuntime,
} from "../server/client";

export type { ServerOptions, ServerCaptureContext, RequestScope } from "../server/client";
export { ServerErrorKit, parseSid, shouldCapture } from "../server/client";

export interface NodeOptions extends ServerOptions {
  /** Install process handlers. Default true. */
  captureUnhandled?: boolean;
  /** Default "warn". */
  unhandledRejections?: "warn" | "strict";
  /** Max wait for the final flush before exiting on a crash. Default 2000 ms. */
  shutdownTimeoutMs?: number;
}

const storage = new AsyncLocalStorage<RequestScope>();
let client: ServerErrorKit | null = null;
let uninstall: (() => void) | null = null;

export function init(options: NodeOptions, runtime: ServerRuntime = defaultRuntime()): ServerErrorKit | null {
  if (client) return client;
  if (!options?.secretKey || options.enabled === false) return null;
  client = new ServerErrorKit(options, runtime, () => storage.getStore(), "himetrica.errorkit.node");
  if (options.captureUnhandled !== false) uninstall = installProcessHandlers(client, options);
  return client;
}

export function getClient(): ServerErrorKit | null {
  return client;
}

export function captureException(error: unknown, ctx?: ServerCaptureContext): void {
  client?.captureException(error, ctx);
}

export function captureMessage(message: string, level?: Level, ctx?: ServerCaptureContext): void {
  client?.captureMessage(message, level, ctx);
}

export function flush(timeoutMs?: number): Promise<boolean> {
  return client ? client.flush(timeoutMs) : Promise.resolve(true);
}

export async function close(timeoutMs?: number): Promise<boolean> {
  const c = client;
  uninstall?.();
  uninstall = null;
  client = null;
  return c ? c.close(timeoutMs) : true;
}

/** Runs fn with a request scope (for frameworks without a helper below). */
export function withScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Merges fields into the current request scope (route known only after matching, user tags...). */
export function setScope(fields: Partial<RequestScope>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function scopeFromHeaders(
  get: (name: string) => string | null | undefined,
  method?: string,
  url?: string,
  route?: string,
): RequestScope {
  return { ...parseSid(get("x-hm-sid")), method, url: pathOf(url), route };
}

// ── Express ────────────────────────────────────────────────────

type ExpressReq = { method?: string; originalUrl?: string; url?: string; route?: { path?: string }; get?(name: string): string | undefined; headers?: Record<string, string | string[] | undefined> };
type ExpressNext = (err?: unknown) => void;

function headerFrom(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export const errorKitExpress = {
  /** First middleware: opens the request scope. */
  requestHandler() {
    return (req: ExpressReq, _res: unknown, next: ExpressNext) => {
      const scope = scopeFromHeaders((n) => req.get?.(n) ?? headerFrom(req.headers, n), req.method, req.originalUrl ?? req.url);
      storage.run(scope, () => next());
    };
  },
  /** After the routes: captures 5xx, then hands the error on unchanged. */
  errorHandler() {
    return (err: unknown, req: ExpressReq, _res: unknown, next: ExpressNext) => {
      if (shouldCapture(err)) {
        const scope = storage.getStore() ?? scopeFromHeaders((n) => req.get?.(n) ?? headerFrom(req.headers, n), req.method, req.originalUrl ?? req.url);
        if (req.route?.path) scope.route = req.route.path;
        client?.captureUnhandled(err, "request", { scope });
      }
      next(err);
    };
  },
};

// ── Hono ───────────────────────────────────────────────────────

type HonoCtx = { req: { method: string; url: string; routePath?: string; header(name: string): string | undefined }; error?: unknown; res?: { status: number } };

/**
 * app.use("*", errorKitHono()). Captures errors Hono routed to onError (c.error)
 * and anything thrown past it; status comes from the error (HTTPException) or the response.
 */
export function errorKitHono() {
  return async (c: HonoCtx, next: () => Promise<void>) => {
    const scope = scopeFromHeaders((n) => c.req.header(n), c.req.method, c.req.url);
    await storage.run(scope, async () => {
      try {
        await next();
      } catch (err) {
        scope.route = c.req.routePath;
        if (shouldCapture(err)) client?.captureUnhandled(err, "request", { scope });
        throw err;
      }
      if (c.error && shouldCapture(c.error)) {
        scope.route = c.req.routePath;
        client?.captureUnhandled(c.error, "request", { scope });
      }
    });
  };
}

// ── Fastify ────────────────────────────────────────────────────

type FastifyReq = { method: string; url: string; routeOptions?: { url?: string }; headers: Record<string, string | string[] | undefined> };
type FastifyLike = {
  addHook(name: "onRequest", fn: (req: FastifyReq, reply: unknown, done: () => void) => void): unknown;
  addHook(name: "onError", fn: (req: FastifyReq, reply: { statusCode?: number }, error: unknown, done: () => void) => void): unknown;
};

/** fastify.register-free setup: errorKitFastify(app). */
export function errorKitFastify(app: FastifyLike): void {
  app.addHook("onRequest", (req, _reply, done) => {
    const scope = scopeFromHeaders((n) => headerFrom(req.headers, n), req.method, req.url);
    storage.run(scope, done);
  });
  app.addHook("onError", (req, reply, error, done) => {
    const status = (error as { statusCode?: number })?.statusCode ?? reply.statusCode;
    if (status === undefined || status >= 500) {
      const scope = storage.getStore() ?? scopeFromHeaders((n) => headerFrom(req.headers, n), req.method, req.url);
      scope.route = req.routeOptions?.url;
      client?.captureUnhandled(error, "request", { scope });
    }
    done();
  });
}

// ── Process handlers ───────────────────────────────────────────

function installProcessHandlers(c: ServerErrorKit, options: NodeOptions): () => void {
  const timeout = options.shutdownTimeoutMs ?? 2000;
  const mode = options.unhandledRejections ?? "warn";

  const onUncaught = (error: unknown) => {
    c.captureUnhandled(error, "uncaught", { level: "fatal" });
    // Our listener suppresses Node's default crash; if it is the only one, restore
    // the default: report, then exit(1) after a bounded flush.
    const others = process.listeners("uncaughtException").filter((l) => l !== onUncaught);
    if (others.length > 0) {
      void c.flush(timeout);
      return;
    }
    // eslint-disable-next-line no-console
    console.error(error);
    void c.flush(timeout).finally(() => process.exit(1));
  };

  const onRejection = (reason: unknown) => {
    c.captureUnhandled(reason, "unhandledrejection", { level: mode === "strict" ? "fatal" : "error" });
    if (mode === "strict") {
      // eslint-disable-next-line no-console
      console.error(reason);
      void c.flush(timeout).finally(() => process.exit(1));
    }
  };

  // beforeExit fires again whenever the loop gets new work; flushing only when
  // something is pending keeps it from re-arming forever.
  const onExit = () => {
    if (c.hasPending()) void c.flush(timeout);
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  process.on("beforeExit", onExit);
  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    process.off("beforeExit", onExit);
  };
}

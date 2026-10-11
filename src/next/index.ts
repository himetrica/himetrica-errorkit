// @himetrica/errorkit/next: Himetrica ErrorKit for Next.js (15+), Node and edge.
//
// instrumentation.ts:
//   import { register as ek, onRequestError as ekOnRequestError } from "@himetrica/errorkit/next";
//   export function register() { ek({ release: process.env.VERCEL_GIT_COMMIT_SHA }); }
//   export const onRequestError = ekOnRequestError;
//
// The secret key comes from HIMETRICA_SECRET_KEY unless passed. No node:* imports:
// the same module runs in the Node and edge runtimes. Request context is passed
// explicitly (edge has no AsyncLocalStorage), from the request Next hands to
// onRequestError, including x-hm-sid so the 500 joins the visitor who caused it.
//
// RSC errors carry a `digest`. On the server the original message is intact, so
// grouping is the default one; the digest rides as a tag. When an error reaches us
// with Next's generic production text instead of the real message, the digest is
// the only thing that tells two of them apart, so it becomes the fingerprint.

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

export interface NextOptions extends Partial<ServerOptions> {}

/** What Next passes to onRequestError (next/dist/server/instrumentation/types). */
export interface NextRequestInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}
export interface NextErrorContext {
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "middleware";
  renderSource?: string;
  revalidateReason?: string;
  renderType?: string;
}

const GENERIC_MESSAGE = /An error occurred in the Server Components render|omitted in production builds|An unexpected response was received from the server/i;
const KEY = Symbol.for("himetrica.errorkit.next");
type Holder = { client?: ServerErrorKit | null };

// Next can evaluate this module more than once (server, edge, separate bundles);
// one client per realm.
function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  return (g[KEY] ??= {});
}

function envVar(name: string): string | undefined {
  try {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

export function register(options: NextOptions = {}, runtime: ServerRuntime = defaultRuntime()): ServerErrorKit | null {
  const h = holder();
  if (h.client) return h.client;
  const secretKey = options.secretKey ?? envVar("HIMETRICA_SECRET_KEY");
  if (!secretKey || options.enabled === false) return (h.client = null);
  h.client = new ServerErrorKit(
    {
      ...options,
      secretKey,
      apiUrl: options.apiUrl ?? envVar("HIMETRICA_API_URL"),
      environment: options.environment ?? envVar("VERCEL_ENV") ?? envVar("NODE_ENV"),
      release: options.release ?? envVar("VERCEL_GIT_COMMIT_SHA"),
    },
    runtime,
    () => undefined,
    envVar("NEXT_RUNTIME") === "edge" ? "himetrica.errorkit.next.edge" : "himetrica.errorkit.next",
  );
  return h.client;
}

export function getClient(): ServerErrorKit | null {
  return holder().client ?? null;
}

/** export const onRequestError = ... in instrumentation.ts */
export async function onRequestError(error: unknown, request: NextRequestInfo, context: NextErrorContext): Promise<void> {
  // Prerender bail-outs (dynamic usage, notFound, redirect) are control flow, not bugs.
  if (isControlFlow(error)) return;
  if (!shouldCapture(error)) return;
  const client = getClient() ?? register();
  if (!client) return;

  const digest = (error as { digest?: unknown } | null)?.digest;
  const message = (error as { message?: unknown } | null)?.message;
  const header = (name: string) => {
    const v = request.headers?.[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const scope: RequestScope = {
    ...parseSid(header("x-hm-sid")),
    url: pathOf(request.path),
    method: request.method,
    route: context.routePath,
    tags: {
      "next.router": context.routerKind === "App Router" ? "app" : "pages",
      "next.route_type": context.routeType,
      ...(typeof digest === "string" ? { "next.digest": digest } : {}),
      ...(context.renderSource ? { "next.render_source": context.renderSource } : {}),
    },
  };
  const ctx: ServerCaptureContext = { scope };
  if (typeof digest === "string" && typeof message === "string" && GENERIC_MESSAGE.test(message)) {
    ctx.fingerprint = ["next-digest", digest];
  }
  client.captureUnhandled(error, "request", ctx);

  const flush = client.flush(1500).then(() => undefined);
  const waitUntil = vercelWaitUntil();
  if (waitUntil) waitUntil(flush);
  else await flush;
}

/** Wraps an App Router route handler: captures 5xx/throws with the request scope, rethrows. */
export function withErrorKit<Args extends [Request, ...unknown[]]>(handler: (...args: Args) => Promise<Response> | Response) {
  return async (...args: Args): Promise<Response> => {
    const req = args[0];
    try {
      return await handler(...args);
    } catch (error) {
      if (!isControlFlow(error) && shouldCapture(error)) {
        const client = getClient() ?? register();
        client?.captureUnhandled(error, "request", {
          scope: { ...parseSid(req.headers.get("x-hm-sid")), url: pathOf(req.url), method: req.method },
        });
        const flush = client?.flush(1500);
        const waitUntil = vercelWaitUntil();
        if (flush && waitUntil) waitUntil(flush);
        else if (flush) await flush;
      }
      throw error;
    }
  };
}

export function captureException(error: unknown, ctx?: ServerCaptureContext): void {
  (getClient() ?? register())?.captureException(error, ctx);
}

export function captureMessage(message: string, level?: Level, ctx?: ServerCaptureContext): void {
  (getClient() ?? register())?.captureMessage(message, level, ctx);
}

export function flush(timeoutMs?: number): Promise<boolean> {
  const client = getClient();
  return client ? client.flush(timeoutMs) : Promise.resolve(true);
}

function isControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return false;
  return digest === "DYNAMIC_SERVER_USAGE" || digest === "BAILOUT_TO_CLIENT_SIDE_RENDERING" || digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK");
}

/** Vercel's request context (Node and edge) exposes waitUntil; elsewhere we await. */
function vercelWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } }>)[Symbol.for("@vercel/request-context")];
    const fn = ctx?.get?.()?.waitUntil;
    return typeof fn === "function" ? fn : undefined;
  } catch {
    return undefined;
  }
}

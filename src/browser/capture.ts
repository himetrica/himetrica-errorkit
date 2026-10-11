// Global capture: everything that patches the page. Each install returns its undo.
//
//   window.onerror        CHAINED: the previous handler still runs, and its return
//                         value is kept (the v1 errors.js replaced it).
//   unhandledrejection    non-Error reasons become "Non-Error promise rejection
//                         captured with value: ...", a message the core knows.
//   wrapped browser APIs  setTimeout/setInterval/requestAnimationFrame callbacks and
//                         addEventListener listeners run inside try/catch, so the
//                         error is caught with its real stack (not the cross-origin
//                         "Script error.") and rethrown untouched. The client marks
//                         it, so the rethrow reaching onerror is not counted twice.
//   console.error         opt-in.
//   fetch x-hm-sid        same-origin only: links a server-side error to the visitor.
//                         Never cross-origin, where a custom header forces a CORS
//                         preflight the other server may reject.

import type { ErrorKitClient } from "./client";
import { safeString } from "./client";
import { readIdentity } from "./identity";
import type { Env } from "./env";

type Undo = () => void;

export function installGlobalHandlers(client: ErrorKitClient, win: Window & typeof globalThis): Undo {
  const undos: Undo[] = [];

  // ── window.onerror (chained) ────────────────────────────────
  const previous = win.onerror;
  win.onerror = function (this: unknown, message, source, lineno, colno, error) {
    if (error !== undefined && error !== null) client.captureThrown(error, "onerror");
    else client.captureRaw(typeof message === "string" ? message : "Unknown error", source, lineno, colno);
    // eslint-disable-next-line prefer-rest-params
    return typeof previous === "function" ? previous.apply(this, arguments as unknown as Parameters<OnErrorEventHandlerNonNull>) : false;
  };
  undos.push(() => {
    win.onerror = previous;
  });

  // ── unhandledrejection ──────────────────────────────────────
  const onRejection = (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    if (reason instanceof Error || (typeof reason === "object" && reason !== null && "message" in reason)) {
      client.captureThrown(reason, "unhandledrejection");
    } else {
      client.captureThrown(
        { name: "UnhandledRejection", message: `Non-Error promise rejection captured with value: ${safeString(reason)}` },
        "unhandledrejection",
      );
    }
  };
  win.addEventListener("unhandledrejection", onRejection);
  undos.push(() => win.removeEventListener("unhandledrejection", onRejection));

  if (client.options.wrapBrowserApis !== false) undos.push(wrapBrowserApis(client, win));
  if (client.options.captureConsole) undos.push(wrapConsole(client, win));

  return () => {
    for (const undo of undos.reverse()) undo();
  };
}

function wrapFn<T extends (...args: never[]) => unknown>(client: ErrorKitClient, fn: T): T {
  const wrapped = function (this: unknown, ...args: never[]) {
    try {
      return fn.apply(this, args);
    } catch (err) {
      client.captureThrown(err, "wrapped");
      throw err;
    }
  };
  return wrapped as unknown as T;
}

function wrapBrowserApis(client: ErrorKitClient, win: Window & typeof globalThis): Undo {
  const undos: Undo[] = [];

  for (const name of ["setTimeout", "setInterval"] as const) {
    const original = win[name];
    if (typeof original !== "function") continue;
    const patched = function (this: unknown, handler: TimerHandler, ...rest: unknown[]) {
      const h = typeof handler === "function" ? wrapFn(client, handler as (...a: never[]) => unknown) : handler;
      return (original as (...a: unknown[]) => number).call(this ?? win, h, ...rest);
    };
    (win as unknown as Record<string, unknown>)[name] = patched;
    undos.push(() => {
      (win as unknown as Record<string, unknown>)[name] = original;
    });
  }

  const raf = win.requestAnimationFrame;
  if (typeof raf === "function") {
    win.requestAnimationFrame = function (this: unknown, cb: FrameRequestCallback) {
      return raf.call(this ?? win, wrapFn(client, cb));
    };
    undos.push(() => {
      win.requestAnimationFrame = raf;
    });
  }

  // addEventListener: the wrapper must be what removeEventListener receives, so the
  // mapping is kept per (listener, type, capture). Listener OBJECTS (handleEvent)
  // are left alone.
  const proto = win.EventTarget?.prototype;
  if (proto) {
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    const wrappers = new WeakMap<object, Map<string, EventListener>>();
    const keyOf = (type: string, opts?: boolean | EventListenerOptions) =>
      `${type}|${typeof opts === "boolean" ? opts : !!opts?.capture}`;

    proto.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
      if (typeof listener !== "function") return add.call(this, type, listener, opts);
      let byKey = wrappers.get(listener);
      if (!byKey) {
        byKey = new Map();
        wrappers.set(listener, byKey);
      }
      const key = keyOf(type, opts);
      let wrapped = byKey.get(key);
      if (!wrapped) {
        wrapped = wrapFn(client, listener as (...a: never[]) => unknown) as EventListener;
        byKey.set(key, wrapped);
      }
      return add.call(this, type, wrapped, opts);
    };
    proto.removeEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
      const wrapped = typeof listener === "function" ? wrappers.get(listener)?.get(keyOf(type, opts)) : undefined;
      // Listeners added before install were never wrapped: remove the original too.
      if (wrapped) remove.call(this, type, wrapped, opts);
      return remove.call(this, type, listener, opts);
    };
    undos.push(() => {
      proto.addEventListener = add;
      proto.removeEventListener = remove;
    });
  }

  return () => {
    for (const undo of undos.reverse()) undo();
  };
}

function wrapConsole(client: ErrorKitClient, win: Window & typeof globalThis): Undo {
  const original = win.console?.error;
  if (typeof original !== "function") return () => {};
  let inside = false;
  win.console.error = function (...args: unknown[]) {
    if (!inside) {
      inside = true;
      try {
        const err = args.find((a) => a instanceof Error);
        if (err) client.captureThrown(err, "console");
        else client.captureThrown({ name: "ConsoleError", message: args.map(safeString).join(" ") }, "console");
      } catch {
        // Never let capture break logging.
      } finally {
        inside = false;
      }
    }
    return original.apply(win.console, args);
  };
  return () => {
    win.console.error = original;
  };
}

/** Adds x-hm-sid: <visitorId>.<sessionId> to same-origin fetches. */
export function installSessionPropagation(env: Env, win: Window & typeof globalThis): Undo {
  const original = win.fetch;
  if (typeof original !== "function") return () => {};
  win.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, win.location.href).origin === win.location.origin) {
        const { visitorId, sessionId } = readIdentity(env);
        if (visitorId || sessionId) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          if (!headers.has("x-hm-sid")) headers.set("x-hm-sid", `${visitorId ?? ""}.${sessionId ?? ""}`);
          return original.call(win, input, { ...init, headers });
        }
      }
    } catch {
      // Unparseable URL or exotic input: send it untouched.
    }
    return original.call(win, input, init);
  } as typeof fetch;
  return () => {
    win.fetch = original;
  };
}

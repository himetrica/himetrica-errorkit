// @himetrica/errorkit: Himetrica ErrorKit for the browser.
//
//   import { init, captureException } from "@himetrica/errorkit";
//   init({ apiKey: "hm_...", release: "web@1.42.0" });
//
// Separate from the analytics tracker and optional. When the tracker is on the page,
// errors join its visitor and session (read-only, see browser/identity.ts).
//
// Guards mirror tracker-js: no-op outside a browser, inside iframes (the parent page
// reports its own), on localhost unless allowLocalhost, for automated browsers
// (navigator.webdriver), with DNT/GPC when respectDNT, and on a second init.

import { browserEnv, isBrowser } from "./browser/env";
import { ErrorKitClient, type CaptureContext, type ErrorKitOptions } from "./browser/client";
import { installGlobalHandlers, installSessionPropagation } from "./browser/capture";
import type { Level } from "./core/types";

export type { ErrorKitOptions, CaptureContext } from "./browser/client";
export type { ErrorEvent, ErrorCount, ErrorBatch, Level, Mechanism } from "./core/types";
export { ErrorKitClient, SDK_NAME, SDK_VERSION } from "./browser/client";

type ErrorKitWindow = Window & typeof globalThis & { __himetricaErrorKit?: ErrorKitClient };

let client: ErrorKitClient | null = null;
let uninstall: (() => void) | null = null;

export function init(options: ErrorKitOptions): ErrorKitClient | null {
  if (!isBrowser || client) return client;
  if (!options?.apiKey || options.enabled === false) return null;
  const win = window as ErrorKitWindow;
  if (win.__himetricaErrorKit) return win.__himetricaErrorKit;

  try {
    if (win.self !== win.top) return null;
  } catch {
    return null; // sandboxed iframe: window.top throws
  }
  const host = win.location.hostname;
  if (!options.allowLocalhost && (host === "localhost" || host === "127.0.0.1" || host === "::1")) return null;
  const nav = win.navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.webdriver) return null;
  if (options.respectDNT && (nav.doNotTrack === "1" || nav.globalPrivacyControl)) return null;

  const env = browserEnv();
  client = new ErrorKitClient(options, env, { origin: win.location.origin, pathname: win.location.pathname });
  win.__himetricaErrorKit = client;

  const undos = [installGlobalHandlers(client, win)];
  if (options.propagateSession !== false) undos.push(installSessionPropagation(env, win));

  const onHide = () => {
    if (document.visibilityState === "hidden") client?.flushOnHide();
  };
  const onPageHide = () => client?.flushOnHide();
  document.addEventListener("visibilitychange", onHide);
  win.addEventListener("pagehide", onPageHide);
  undos.push(() => {
    document.removeEventListener("visibilitychange", onHide);
    win.removeEventListener("pagehide", onPageHide);
  });

  uninstall = () => {
    for (const undo of undos.reverse()) undo();
  };
  return client;
}

export function captureException(error: unknown, ctx?: CaptureContext): void {
  client?.captureException(error, ctx);
}

export function captureMessage(message: string, level?: Level): void {
  client?.captureMessage(message, level);
}

export function setTag(key: string, value: string): void {
  client?.setTag(key, value);
}

export function setUser(user: { id?: string } | null): void {
  client?.setUser(user);
}

export function flush(): Promise<void> {
  return client ? client.flush() : Promise.resolve();
}

/** Sends what is pending and removes every patch. */
export function close(): void {
  if (!client) return;
  client.close();
  uninstall?.();
  uninstall = null;
  if (isBrowser) delete (window as ErrorKitWindow).__himetricaErrorKit;
  client = null;
}

export function getClient(): ErrorKitClient | null {
  return client;
}

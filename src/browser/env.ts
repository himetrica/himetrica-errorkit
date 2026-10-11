// Browser globals behind one interface.
//
// Everything that touches window/document/navigator/storage goes through an Env,
// so the collector and the transport run in plain Node under node:test with a fake
// clock, fake storage and a fake network. browserEnv() is the real one; it keeps a
// reference to the ORIGINAL fetch, taken before the x-hm-sid patch, so the SDK's own
// requests never carry it.

export interface Env {
  now(): number;
  uuid(): string;
  random(): number;
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number; headers: { get(name: string): string | null } }>;
  sendBeacon?: (url: string, body: string) => boolean;
  getLocal(key: string): string | null;
  getSession(key: string): string | null;
  setSession(key: string, value: string): void;
  getCookie(name: string): string | null;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

export function uuidV4(random: () => number = Math.random): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // randomUUID throws on insecure origins in some browsers; fall through.
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// localStorage/sessionStorage throw in Safari private mode, sandboxed iframes and
// under storage policies; every access is guarded like tracker-js does.
function safeGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

export function browserEnv(): Env {
  const originalFetch = typeof fetch === "function" ? fetch.bind(globalThis) : undefined;
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    now: () => Date.now(),
    uuid: () => uuidV4(),
    random: () => Math.random(),
    fetch: originalFetch as Env["fetch"],
    sendBeacon:
      nav && typeof nav.sendBeacon === "function"
        ? (url, body) => {
            try {
              return nav.sendBeacon(url, new Blob([body], { type: "text/plain" }));
            } catch {
              return false;
            }
          }
        : undefined,
    getLocal: (key) => safeGet(() => localStorage, key),
    getSession: (key) => safeGet(() => sessionStorage, key),
    setSession: (key, value) => {
      try {
        sessionStorage.setItem(key, value);
      } catch {
        // Storage unavailable: the in-memory state still works for this page.
      }
    },
    getCookie: (name) => {
      try {
        const match = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
        return match ? decodeURIComponent(match[1]) : null;
      } catch {
        return null;
      }
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

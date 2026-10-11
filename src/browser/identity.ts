// Identity bridge with the analytics tracker, strictly READ-ONLY.
//
// ErrorKit is a separate SDK, but an error is only worth as much as the visitor and
// session it belongs to. The tracker (tracker-js / tracker.js) stores them in:
//   visitor  cookie hm_vid (cookieDomain mode) or localStorage hm_visitor_id
//   session  cookie hm_sid (cookieDomain mode) or sessionStorage hm_session_id
// We read those keys directly and never write them. window.himetrica.getSessionId()
// is deliberately NOT called: in the tracker it refreshes the session timestamp, so
// an error loop would keep a dead session alive.
//
// Without the tracker on the page both are undefined and ErrorKit falls back to its
// own page-session id for the "once per session" fold (see client.ts).

import type { Env } from "./env";

export interface Identity {
  visitorId?: string;
  sessionId?: string;
}

export function readIdentity(env: Env): Identity {
  const visitorId = env.getCookie("hm_vid") || env.getLocal("hm_visitor_id") || undefined;
  const sessionId = env.getCookie("hm_sid") || env.getSession("hm_session_id") || undefined;
  return { visitorId, sessionId };
}

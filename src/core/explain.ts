// Canonical error codes: the same bug reads differently in each engine.
//
//   Chrome   Cannot read properties of undefined (reading 'id')
//   Firefox  can't access property "id", user is undefined
//   Safari   undefined is not an object (evaluating 'user.id')
//
// All three become `read_of_nullish{prop: "id", value: "undefined"}`. The code
// (not the raw text) is what goes into the issue key, so one bug across browsers
// is one issue, and it is also what the human title is written from.

export type ExplainCode =
  | "read_of_nullish"
  | "not_a_function"
  | "not_defined"
  | "not_iterable"
  | "chunk_load"
  | "network"
  | "hydration"
  | "max_call_stack"
  | "json_parse"
  | "quota_exceeded"
  | "aborted"
  | "timeout"
  | "script_error"
  | "resize_observer"
  | "non_error_rejection"
  | "unknown";

export interface Explained {
  code: ExplainCode;
  /** Identifiers pulled from the message (`prop`, `name`, `value`), never user data. */
  params: Record<string, string>;
}

type Rule = { code: ExplainCode; re: RegExp; params?: (m: RegExpExecArray) => Record<string, string> };

const lastSegment = (path: string) => path.split(".").pop() ?? path;

const RULES: Rule[] = [
  // Chrome >= 91
  { code: "read_of_nullish", re: /Cannot (?:read|set) propert(?:y|ies) of (undefined|null)(?: \((?:reading|setting) '([^']+)'\))?/,
    params: (m) => ({ value: m[1], ...(m[2] ? { prop: m[2] } : {}) }) },
  // Chrome < 91
  { code: "read_of_nullish", re: /Cannot (?:read|set) property '([^']+)' of (undefined|null)/,
    params: (m) => ({ prop: m[1], value: m[2] }) },
  // Firefox
  { code: "read_of_nullish", re: /can't access property "([^"]+)",? .*? is (undefined|null)/,
    params: (m) => ({ prop: m[1], value: m[2] }) },
  { code: "read_of_nullish", re: /^\S+ is (undefined|null)$/, params: (m) => ({ value: m[1] }) },
  { code: "read_of_nullish", re: /^\S+ has no properties$/, params: () => ({ value: "undefined" }) },
  // Safari
  { code: "read_of_nullish", re: /(undefined|null) is not an object \(evaluating '([^']+)'\)/,
    params: (m) => ({ value: m[1], prop: lastSegment(m[2]) }) },

  { code: "not_a_function", re: /(?:^|\s)([\w$.[\]]+) is not a function/, params: (m) => ({ name: lastSegment(m[1]) }) },
  { code: "not_a_function", re: /'([^']+)' is not a function/, params: (m) => ({ name: lastSegment(m[1]) }) },
  { code: "not_defined", re: /^([\w$]+) is not defined$/, params: (m) => ({ name: m[1] }) },
  { code: "not_defined", re: /^Can't find variable: ([\w$]+)/, params: (m) => ({ name: m[1] }) },
  { code: "not_iterable", re: /is not iterable|is not a function or its return value is not iterable/ },

  { code: "chunk_load", re: /Loading (?:CSS )?chunk [\w-]+ failed|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i },
  { code: "network", re: /^(?:TypeError: )?(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed|The network connection was lost\.?)$/i },
  { code: "hydration", re: /Hydration failed|hydrating|did not match\. Server|Text content does not match server-rendered|Minified React error #(?:418|419|421|422|423|425)/i },
  { code: "max_call_stack", re: /Maximum call stack size exceeded|too much recursion/i },
  { code: "json_parse", re: /JSON\.parse|Unexpected token .* in JSON|is not valid JSON|JSON Parse error/i },
  { code: "quota_exceeded", re: /QuotaExceededError|exceeded the quota/i },
  { code: "aborted", re: /AbortError|The (?:user|operation) aborted|signal is aborted|aborted a request/i },
  { code: "timeout", re: /timed? ?out|TimeoutError/i },
  { code: "script_error", re: /^Script error\.?$/ },
  { code: "resize_observer", re: /ResizeObserver loop/ },
  { code: "non_error_rejection", re: /^Non-Error promise rejection captured/ },
];

export function explain(type: string, message: string): Explained {
  const text = message.trim();
  if (type === "ChunkLoadError") return { code: "chunk_load", params: {} };
  if (type === "AbortError") return { code: "aborted", params: {} };
  if (type === "QuotaExceededError") return { code: "quota_exceeded", params: {} };
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) return { code: rule.code, params: rule.params ? rule.params(m) : {} };
  }
  return { code: "unknown", params: {} };
}

/** Errors that are never the customer's bug; dropped by the SDK unless opted in. */
export const NOISE_CODES: ReadonlySet<ExplainCode> = new Set(["script_error", "resize_observer"]);

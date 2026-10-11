// Human title for an issue, written from the canonical code and the culprit.
//
// Deterministic and free: no model call per error. Jev rewrites it once per new
// issue later (phase 7); this is the title until then and the fallback forever.

import type { Grouping } from "./fingerprint";
import { parameterize } from "./normalize";
import type { ExceptionValue } from "./types";

export type TitleLocale = "en" | "pt";

type Params = { prop?: string; name?: string; value?: string; where?: string; type: string; message: string };
type Template = (p: Params) => string;

const at = (where: string | undefined, word: string) => (where ? ` ${word} ${where}` : "");

const EN: Record<string, Template> = {
  read_of_nullish: (p) =>
    p.prop
      ? `Reading '${p.prop}' of ${p.value ?? "undefined"}${at(p.where, "in")}`
      : `Accessing a property of ${p.value ?? "undefined"}${at(p.where, "in")}`,
  not_a_function: (p) => `'${p.name}' is not a function${at(p.where, "in")}`,
  not_defined: (p) => `'${p.name}' is not defined${at(p.where, "in")}`,
  not_iterable: (p) => `Iterating over a non-iterable value${at(p.where, "in")}`,
  chunk_load: () => "App chunk failed to load (likely a new deploy)",
  network: (p) => `Network request failed${at(p.where, "in")}`,
  hydration: () => "Server and browser rendered different content (hydration)",
  max_call_stack: (p) => `Infinite recursion${at(p.where, "in")}`,
  json_parse: (p) => `Invalid JSON${at(p.where, "in")}`,
  quota_exceeded: () => "Browser storage is full",
  aborted: (p) => `Request aborted${at(p.where, "in")}`,
  timeout: (p) => `Timed out${at(p.where, "in")}`,
  script_error: () => "Error in a cross-origin script (no details)",
  resize_observer: () => "ResizeObserver loop warning (harmless)",
  non_error_rejection: () => "Promise rejected with a non-Error value",
  unknown: (p) => `${p.type}: ${p.message}${at(p.where, "in")}`,
};

const PT: Record<string, Template> = {
  read_of_nullish: (p) =>
    p.prop
      ? `Leitura de '${p.prop}' em valor ${p.value === "null" ? "nulo" : "indefinido"}${at(p.where, "em")}`
      : `Acesso a propriedade de valor ${p.value === "null" ? "nulo" : "indefinido"}${at(p.where, "em")}`,
  not_a_function: (p) => `'${p.name}' não é uma função${at(p.where, "em")}`,
  not_defined: (p) => `'${p.name}' não está definido${at(p.where, "em")}`,
  not_iterable: (p) => `Iteração sobre valor não iterável${at(p.where, "em")}`,
  chunk_load: () => "Falha ao carregar parte do app (provável deploy novo)",
  network: (p) => `Falha de rede em requisição${at(p.where, "em")}`,
  hydration: () => "Servidor e navegador renderizaram conteúdos diferentes (hidratação)",
  max_call_stack: (p) => `Recursão infinita${at(p.where, "em")}`,
  json_parse: (p) => `JSON inválido${at(p.where, "em")}`,
  quota_exceeded: () => "Armazenamento do navegador cheio",
  aborted: (p) => `Requisição cancelada${at(p.where, "em")}`,
  timeout: (p) => `Tempo esgotado${at(p.where, "em")}`,
  script_error: () => "Erro em script de outro domínio (sem detalhes)",
  resize_observer: () => "Aviso de loop do ResizeObserver (inofensivo)",
  non_error_rejection: () => "Promise rejeitada com valor que não é Error",
  unknown: (p) => `${p.type}: ${p.message}${at(p.where, "em")}`,
};

export function humanTitle(grouping: Grouping, primary: ExceptionValue, locale: TitleLocale = "en"): string {
  const templates = locale === "pt" ? PT : EN;
  const where = grouping.culprit?.function ?? basename(grouping.culprit?.file);
  const message = parameterize(primary.message).slice(0, 80) || primary.type;
  const template = templates[grouping.explained.code] ?? templates.unknown;
  return template({ ...grouping.explained.params, where, type: primary.type, message });
}

/** Culprit as shown under the title: `loadUser (app/hooks/useuser.ts)`. */
export function culpritLabel(grouping: Grouping): string | undefined {
  const c = grouping.culprit;
  if (!c) return undefined;
  return c.function ? `${c.function} (${c.file})` : c.file;
}

function basename(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const base = file.split("/").pop();
  return base && base !== "<anonymous>" ? base : undefined;
}

/**
 * Wire protocol shared by the browser client and the log collector server.
 *
 * Keep this file free of DOM and Node API usage: it is bundled into both the
 * browser build and the CLI build. Constants live here so the client default
 * and the server default can never drift apart.
 */

export const PROTOCOL_VERSION = 1;

export const DEFAULT_PORT = 5959;
export const DEFAULT_HOST = "127.0.0.1";

export const LOGS_PATH = "/__daijin/logs";
export const HEALTH_PATH = "/__daijin/health";

/** Maximum accepted request body size. Larger bodies are rejected with 413. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Maximum entries in one batch. `MAX_BODY_BYTES` alone bounds a request to
 * ~26000 minimal entries, and there is no rate limit behind it, so this caps
 * how fast a page can drive the writer.
 */
export const MAX_ENTRIES_PER_BATCH = 1000;

/** Largest magnitude `Date` accepts; beyond it `new Date(t)` is Invalid Date. */
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export type LogLevel = "log" | "info" | "warn" | "error" | "uncaught";

export const LOG_LEVELS: readonly LogLevel[] = [
  "log",
  "info",
  "warn",
  "error",
  "uncaught",
];

export interface LogEntry {
  /** Epoch milliseconds. */
  t: number;
  level: LogLevel;
  /** Arguments, already serialized to strings by the client. */
  args: string[];
  /** Stack trace, when one is available. */
  stack?: string;
  /** URL of the page the entry originated from. */
  url?: string;
}

export interface LogBatch {
  v: number;
  session: string;
  entries: LogEntry[];
}

/**
 * Built from `DEFAULT_HOST` rather than "localhost" on purpose. On a
 * dual-stack machine "localhost" resolves to both ::1 and 127.0.0.1, and
 * browsers prefer ::1 — which is not where the server binds. Deriving the
 * client default from the server default is the whole reason this file exists.
 */
export function defaultEndpoint(port: number = DEFAULT_PORT): string {
  return `http://${DEFAULT_HOST}:${port}${LOGS_PATH}`;
}

/**
 * True for hostnames that always resolve to the local machine.
 *
 * `.local` (mDNS) is deliberately excluded: it can name a different machine on
 * the network. Those setups must opt in explicitly via `--allow-origin`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    // URL.hostname keeps the brackets for IPv6 literals.
    hostname === "[::1]" ||
    hostname.endsWith(".localhost") ||
    // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
    isIpv4Loopback(hostname)
  );
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((p) => p === "" || !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  return parts[0] === "127";
}

/** True when `origin` is a well-formed http(s) origin pointing at loopback. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackHostname(url.hostname);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Validates a decoded request body against the protocol.
 *
 * Returns the batch on success or an error message on failure, so the server
 * can answer 400 with something actionable instead of crashing on bad input.
 */
export function parseLogBatch(value: unknown): { batch: LogBatch } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "body must be a JSON object" };
  }
  const raw = value as Record<string, unknown>;

  if (raw.v !== PROTOCOL_VERSION) {
    return { error: `unsupported protocol version: ${String(raw.v)}` };
  }
  if (typeof raw.session !== "string" || raw.session === "") {
    return { error: "session must be a non-empty string" };
  }
  if (!Array.isArray(raw.entries)) {
    return { error: "entries must be an array" };
  }
  if (raw.entries.length > MAX_ENTRIES_PER_BATCH) {
    return {
      error: `too many entries: ${raw.entries.length} (max ${MAX_ENTRIES_PER_BATCH})`,
    };
  }

  const entries: LogEntry[] = [];
  for (const [index, item] of raw.entries.entries()) {
    if (typeof item !== "object" || item === null) {
      return { error: `entries[${index}] must be an object` };
    }
    const e = item as Record<string, unknown>;
    if (!isLogLevel(e.level)) {
      return { error: `entries[${index}].level is not a known level` };
    }
    if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== "string")) {
      return { error: `entries[${index}].args must be an array of strings` };
    }
    // Rejected rather than silently replaced with Date.now(): every other field
    // here reports why it was refused, and a value outside the `Date` range
    // would render as NaN:NaN:NaN downstream.
    if (typeof e.t !== "number" || !Number.isFinite(e.t) || Math.abs(e.t) > MAX_TIMESTAMP) {
      return { error: `entries[${index}].t must be a timestamp in milliseconds` };
    }
    entries.push({
      t: e.t,
      level: e.level,
      args: e.args as string[],
      ...(typeof e.stack === "string" ? { stack: e.stack } : {}),
      ...(typeof e.url === "string" ? { url: e.url } : {}),
    });
  }

  return { batch: { v: PROTOCOL_VERSION, session: raw.session, entries } };
}

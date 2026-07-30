/**
 * Browser to collector transport.
 *
 * Three things this has to get right, all of which are easy to get wrong:
 *  - Batching. One request per log line falls over the first time someone logs
 *    inside a loop.
 *  - Unload. The most valuable log is usually the last one before a crash or a
 *    reload, and a plain `fetch` in flight at that moment is discarded.
 *  - Failing quietly. When the collector is not running, every log must not
 *    turn into a failed request, and reporting the failure must never go
 *    through the patched console.
 */

import { originalConsole, subscribe, type CapturedEntry } from "./capture";
import {
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  defaultEndpoint,
  isLoopbackHostname,
  type LogBatch,
  type LogEntry,
} from "./protocol";

export interface ForwardOptions {
  /** Full endpoint URL. May be relative to use a dev-server proxy. */
  endpoint?: string;
  /** Collector port. Ignored when `endpoint` is given. */
  port?: number;
  /** Buffer window in milliseconds. Default 250. */
  batchMs?: number;
  /** Flush as soon as this many entries are buffered. Default 50. */
  batchSize?: number;
  /** Consecutive failures tolerated before giving up. Default 3. */
  maxFailures?: number;
  /**
   * Forward even when the page is not served from a loopback host.
   * Off by default: shipping this enabled to production would make every
   * visitor's browser POST their console output, which can include tokens and
   * personal data, to whatever is listening on their own machine.
   */
  allowNonLocal?: boolean;
}

/** Hard cap on buffered entries while the collector is unreachable. */
const MAX_BUFFER = 1000;
/** Hard cap per request, to stay well clear of the server's 1 MB body limit. */
const MAX_BATCH_ENTRIES = 200;

function makeSessionId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function toLogEntry(entry: CapturedEntry, url: string | undefined): LogEntry {
  return {
    t: entry.t,
    level: entry.level,
    args: entry.text,
    ...(entry.stack !== undefined ? { stack: entry.stack } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

/**
 * Starts forwarding captured entries to the collector.
 *
 * Returns a function that flushes and detaches. Callers are expected to have
 * installed the capture hooks already.
 */
export function startForwarding(options: ForwardOptions = {}): () => void {
  const noop = (): void => {};

  if (typeof window === "undefined" || typeof fetch !== "function") return noop;

  const endpoint = options.endpoint ?? defaultEndpoint(options.port ?? DEFAULT_PORT);
  const batchMs = options.batchMs ?? 250;
  const batchSize = options.batchSize ?? 50;
  const maxFailures = options.maxFailures ?? 3;

  if (options.allowNonLocal !== true && !isLoopbackHostname(window.location.hostname)) {
    originalConsole.warn(
      `[console-daijin] log forwarding is disabled because this page is served from ` +
        `"${window.location.hostname}", which is not a loopback host. This guard exists so a ` +
        `forwarding build cannot leak console output from production. Pass ` +
        `forward: { allowNonLocal: true } if this is intentional.`,
    );
    return noop;
  }

  const session = makeSessionId();
  const buffer: LogEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let stopped = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const giveUp = (reason: string): void => {
    stopped = true;
    buffer.length = 0;
    clearTimer();
    // Deliberately the pristine console: routing this through the patched one
    // would capture it, forward it, fail again, and loop.
    originalConsole.warn(
      `[console-daijin] stopped forwarding logs after ${failures} failed attempts (${reason}). ` +
        `Is the collector running? npx console-daijin-server`,
    );
  };

  const send = (body: string): void => {
    // `text/plain` keeps this a CORS-simple request, so there is no preflight
    // to lose. The server's Origin check, not the content type, is what makes
    // the endpoint safe.
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body,
      credentials: "omit",
    }).then(
      (res) => {
        if (res.ok) {
          failures = 0;
          return;
        }
        failures += 1;
        if (failures >= maxFailures) giveUp(`server responded ${res.status}`);
      },
      (err: unknown) => {
        failures += 1;
        if (failures >= maxFailures) {
          giveUp(err instanceof Error ? err.message : String(err));
        }
      },
    );
  };

  const flush = (viaBeacon: boolean): void => {
    if (stopped || buffer.length === 0) return;
    clearTimer();

    const entries = buffer.splice(0, MAX_BATCH_ENTRIES);
    const batch: LogBatch = { v: PROTOCOL_VERSION, session, entries };
    const body = JSON.stringify(batch);

    if (viaBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" }));
    } else {
      send(body);
    }

    // A burst larger than one batch keeps draining on subsequent ticks.
    if (buffer.length > 0 && !viaBeacon) {
      timer = setTimeout(() => flush(false), 0);
    }
  };

  const unsubscribe = subscribe((entry) => {
    if (stopped) return;

    buffer.push(toLogEntry(entry, window.location?.href));
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

    if (buffer.length >= batchSize) {
      flush(false);
    } else if (timer === null) {
      timer = setTimeout(() => flush(false), batchMs);
    }
  });

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") flush(true);
  };
  const onPageHide = (): void => flush(true);

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);

  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    flush(true);
    clearTimer();
    stopped = true;
  };
}

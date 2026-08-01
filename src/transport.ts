/**
 * Browser to collector transport.
 *
 * Four things this has to get right, all of which are easy to get wrong:
 *  - Batching. One request per log line falls over the first time someone logs
 *    inside a loop.
 *  - Sizing. Counting entries says nothing about bytes: 200 entries of five
 *    10,000-character arguments is ~9.5 MB, which the server rejects. Batches
 *    are therefore measured in bytes.
 *  - Unload. The most valuable log is usually the last one before a crash or a
 *    reload, so the whole buffer is drained with `sendBeacon` — all of it, not
 *    the first batch — and the failure return is honoured.
 *  - Failing quietly, and for the right reason. When the collector is not
 *    running, every log must not turn into a failed request; reporting that
 *    must never go through the patched console; and a rejected payload must
 *    not be reported as "the collector isn't running".
 */

import { originalConsole, subscribe, type CapturedEntry } from "./capture";
import {
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  MAX_ENTRIES_PER_BATCH,
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
  /** Consecutive network failures tolerated before giving up. Default 3. */
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

/** Half the server's limit, leaving room for the envelope and for growth. */
const MAX_BATCH_BYTES = Math.floor(MAX_BODY_BYTES / 2);

/**
 * `sendBeacon` is capped by the browser's beacon queue, 64 KiB in practice.
 * Over that it returns false and the payload never leaves.
 */
const MAX_BEACON_BYTES = 60 * 1024;

/** Rough size of `{"v":1,"session":"…","entries":[]}` plus separators. */
const ENVELOPE_BYTES = 128;

/** Bound on beacon flush iterations, so unload can never spin. */
const MAX_DRAIN_ROUNDS = 32;

interface Buffered {
  entry: LogEntry;
  bytes: number;
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function byteLength(text: string): number {
  // Without TextEncoder, assume the worst realistic UTF-8 expansion so the
  // estimate stays conservative rather than optimistic.
  return encoder !== null ? encoder.encode(text).length : text.length * 3;
}

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
 * Stands in for an entry too large to send.
 *
 * Trimming such an entry down to fit was not worth what it cost: the sizes
 * involved only arise from an accident like `console.log(...bigArray)`, and
 * part of an accidental log is not more useful than a note saying it happened.
 * Reporting the size gives the reader enough to find it.
 */
function placeholderFor(entry: LogEntry, bytes: number): LogEntry {
  return {
    t: entry.t,
    level: entry.level,
    args: [
      `[console-daijin] dropped one ${Math.round(bytes / 1024)} KB log entry: too large to send`,
    ],
    ...(entry.url !== undefined ? { url: entry.url } : {}),
  };
}

/**
 * Removes entries from the front of the buffer while they fit in `maxBytes`.
 * Always yields at least one entry so a single huge record cannot wedge the
 * queue; that entry is shrunk instead.
 */
function takeBatch(buffer: Buffered[], maxBytes: number): LogEntry[] {
  const taken: LogEntry[] = [];
  let bytes = ENVELOPE_BYTES;

  while (buffer.length > 0 && taken.length < MAX_ENTRIES_PER_BATCH) {
    const next = buffer[0];
    if (taken.length > 0 && bytes + next.bytes > maxBytes) break;

    buffer.shift();
    if (taken.length === 0 && bytes + next.bytes > maxBytes) {
      taken.push(placeholderFor(next.entry, next.bytes));
      break;
    }
    taken.push(next.entry);
    bytes += next.bytes;
  }

  return taken;
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
  const buffer: Buffered[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  /**
   * 400s are counted apart from 413s (see the status handling in `send`), but
   * like `failures` this counts *consecutive* rejections. A receiver that is
   * merely restarting can return the odd 400, and the endpoint is explicitly
   * replaceable — a proxy or a different implementation entirely — so only an
   * unbroken run of them means the two sides do not understand each other.
   */
  let protocolFailures = 0;
  let stopped = false;
  let warnedAboutPayload = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Stops forwarding. `advice` explains what the caller should check. */
  const halt = (message: string): void => {
    stopped = true;
    buffer.length = 0;
    clearTimer();
    // Deliberately the pristine console: routing this through the patched one
    // would capture it, forward it, fail again, and loop.
    originalConsole.warn(`[console-daijin] ${message}`);
  };

  const giveUp = (reason: string): void =>
    halt(
      `stopped forwarding logs after ${failures} failed attempts (${reason}). ` +
        `Is the collector running? npx console-daijin-server`,
    );

  /** Pulls the server's own explanation out of an error response body. */
  const describeRejection = (text: string): string => {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // Fall through to the raw body.
    }
    return text.slice(0, 200);
  };

  const encode = (entries: LogEntry[]): string => {
    const batch: LogBatch = { v: PROTOCOL_VERSION, session, entries };
    return JSON.stringify(batch);
  };

  const send = (body: string, keepalive: boolean): void => {
    // `text/plain` keeps this a CORS-simple request, so there is no preflight
    // to lose. The server's Origin check, not the content type, is what makes
    // the endpoint safe.
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body,
      credentials: "omit",
      keepalive,
    }).then(
      (res) => {
        if (res.ok) {
          failures = 0;
          protocolFailures = 0;
          return;
        }
        // 413 says this particular batch was too big, not that the collector is
        // unreachable. Counting it as a reachability failure would stop
        // forwarding on a busy page and blame a collector that is running and
        // answering. The next, smaller batch may well succeed.
        if (res.status === 413) {
          if (!warnedAboutPayload) {
            warnedAboutPayload = true;
            originalConsole.warn(
              `[console-daijin] the collector rejected a batch as too large (413); that batch ` +
                `was dropped. Forwarding continues.`,
            );
          }
          return;
        }

        // 400 is different again: the commonest cause is a protocol version
        // mismatch, which is permanent. The client and the collector are
        // installed and updated separately, so skew is an ordinary situation,
        // and treating it like an oversized batch would report "forwarding
        // continues" forever while nothing at all arrived.
        if (res.status === 400) {
          protocolFailures += 1;
          if (protocolFailures >= maxFailures) {
            res.text().then(
              (text) =>
                halt(
                  `stopped forwarding logs: the collector rejected ${protocolFailures} batches as ` +
                    `malformed (${describeRejection(text)}). This usually means the browser ` +
                    `library and console-daijin-server are different versions.`,
                ),
              () =>
                halt(
                  `stopped forwarding logs: the collector rejected ${protocolFailures} batches ` +
                    `as malformed (400). Check that the browser library and ` +
                    `console-daijin-server are the same version.`,
                ),
            );
          }
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

  const flush = (): void => {
    if (stopped || buffer.length === 0) return;
    clearTimer();

    const entries = takeBatch(buffer, MAX_BATCH_BYTES);
    if (entries.length > 0) send(encode(entries), false);

    // A burst larger than one batch keeps draining on subsequent ticks.
    if (buffer.length > 0) timer = setTimeout(flush, 0);
  };

  /** Unload path: get everything out now, or lose it. */
  const flushBeacon = (): void => {
    if (stopped || buffer.length === 0) return;
    clearTimer();

    const canBeacon =
      typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function";

    for (let round = 0; round < MAX_DRAIN_ROUNDS && buffer.length > 0; round++) {
      const entries = takeBatch(buffer, canBeacon ? MAX_BEACON_BYTES : MAX_BATCH_BYTES);
      if (entries.length === 0) break;
      const body = encode(entries);

      if (!canBeacon) {
        send(body, true);
        continue;
      }
      // The entries are already out of the buffer, so a false return here is
      // total loss unless it is followed up.
      const queued = navigator.sendBeacon(
        endpoint,
        new Blob([body], { type: "text/plain;charset=UTF-8" }),
      );
      if (!queued) send(body, true);
    }
  };

  const unsubscribe = subscribe((entry) => {
    if (stopped) return;

    const logEntry = toLogEntry(entry, window.location?.href);
    buffer.push({ entry: logEntry, bytes: byteLength(JSON.stringify(logEntry)) + 1 });
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

    if (buffer.length >= batchSize) {
      flush();
    } else if (timer === null) {
      timer = setTimeout(flush, batchMs);
    }
  });

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") flushBeacon();
  };
  const onPageHide = (): void => flushBeacon();

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);

  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    flushBeacon();
    clearTimer();
    stopped = true;
  };
}

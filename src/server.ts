/**
 * Local log collector.
 *
 * Receives batches posted by the browser client and fans them out to stdout
 * and to a JSONL file. Uses `node:http` only, so the package keeps zero
 * runtime dependencies.
 *
 * Security posture: this server exists to be talked to by a page running on
 * the developer's own machine, and its output is meant to be read by tools and
 * agents. Any site the developer visits can also reach `localhost`, so the
 * origin check below is the thing standing between "my dev server" and "any
 * tab writing arbitrary text into a file an agent trusts". It is not optional.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, resolve as resolvePath } from "node:path";

import {
  HEALTH_PATH,
  LOGS_PATH,
  MAX_BODY_BYTES,
  PROTOCOL_VERSION,
  isLoopbackOrigin,
  parseLogBatch,
  type LogEntry,
  type LogLevel,
} from "./protocol";

export interface LogServerOptions {
  port?: number;
  host?: string;
  /** JSONL destination, resolved against cwd. `null` disables file output. */
  out?: string | null;
  /** Keep existing file contents instead of truncating on start. */
  append?: boolean;
  /** Suppress stdout rendering. */
  quiet?: boolean;
  /** Extra origins accepted in addition to loopback. */
  allowOrigins?: readonly string[];
  /** Force-enable or force-disable ANSI colors. Defaults to TTY detection. */
  color?: boolean;
  /** Sink for rendered lines. Defaults to stdout. Present for tests. */
  write?: (line: string) => void;
}

export interface LogServerHandle {
  server: Server;
  host: string;
  port: number;
  /** Absolute path of the JSONL file, or `null` when file output is off. */
  outPath: string | null;
  close(): Promise<void>;
}

const ANSI: Record<LogLevel, string> = {
  log: "",
  info: "\u001b[36m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
  uncaught: "\u001b[1;31m",
};
const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[2m";

/**
 * Cross-origin POSTs always carry `Origin`, so rejecting non-loopback values
 * blocks the drive-by case while leaving curl and other non-browser clients
 * (which send no `Origin` at all) working.
 *
 * `null` is refused: `file://` pages and sandboxed iframes are
 * indistinguishable here, and one of them is an attacker. `--allow-origin null`
 * is available for the `file://` case.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowOrigins: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (allowOrigins.includes(origin)) return true;
  if (origin === "null") return false;
  return isLoopbackOrigin(origin);
}

class JsonlWriter {
  private stream: WriteStream;

  constructor(readonly path: string, append: boolean) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: append ? "a" : "w" });
  }

  write(record: unknown): void {
    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

function formatTimestamp(t: number): string {
  const d = new Date(t);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function renderEntry(entry: LogEntry, color: boolean): string {
  const time = formatTimestamp(entry.t);
  const label = entry.level.padEnd(8);
  const body = entry.args.join(" ");
  // Keep continuation lines of a stack trace visually attached to their header.
  const indented = body.replace(/\n/g, "\n            ");

  if (!color) return `${time} ${label} ${indented}`;
  const tint = ANSI[entry.level];
  const head = `${ANSI_DIM}${time}${ANSI_RESET} ${tint}${label}${ANSI_RESET}`;
  return tint ? `${head} ${tint}${indented}${ANSI_RESET}` : `${head} ${indented}`;
}

function sendCors(
  res: ServerResponse,
  origin: string | undefined,
  allowed: boolean,
): void {
  res.setHeader("Vary", "Origin");
  if (allowed && origin !== undefined) {
    // Never `*`: that would hand every site on the internet a writable endpoint.
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

type BodyResult = { ok: true; text: string } | { ok: false; tooLarge: true };

function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ ok: false, tooLarge: true });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;

    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        // Drain instead of destroying, so the 413 actually reaches the client.
        req.resume();
        resolve({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflowed) resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", reject);
  });
}

export function createLogServer(options: LogServerOptions = {}): {
  server: Server;
  writer: JsonlWriter | null;
} {
  const allowOrigins = options.allowOrigins ?? [];
  const quiet = options.quiet ?? false;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const color =
    options.color ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined);

  const writer =
    options.out === null || options.out === undefined
      ? null
      : new JsonlWriter(resolvePath(options.out), options.append ?? false);

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const allowed = isAllowedOrigin(origin, allowOrigins);
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (!allowed) {
      sendCors(res, origin, false);
      sendJson(res, 403, { error: "origin not allowed", origin });
      return;
    }
    sendCors(res, origin, true);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }

    if (path === HEALTH_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      sendJson(res, 200, { ok: true, v: PROTOCOL_VERSION });
      return;
    }

    if (path !== LOGS_PATH) {
      sendJson(res, 404, { error: "not found", path });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    readBody(req, MAX_BODY_BYTES).then(
      (body) => {
        if (!body.ok) {
          sendJson(res, 413, { error: "payload too large", limit: MAX_BODY_BYTES });
          return;
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(body.text);
        } catch {
          sendJson(res, 400, { error: "body is not valid JSON" });
          return;
        }

        const parsed = parseLogBatch(decoded);
        if ("error" in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }

        for (const entry of parsed.batch.entries) {
          if (!quiet) write(renderEntry(entry, color));
          writer?.write({
            t: entry.t,
            level: entry.level,
            session: parsed.batch.session,
            ...(entry.url !== undefined ? { url: entry.url } : {}),
            args: entry.args,
            ...(entry.stack !== undefined ? { stack: entry.stack } : {}),
          });
        }

        res.writeHead(204);
        res.end();
      },
      () => {
        // Request stream errored (client went away mid-upload); nothing to log.
        if (!res.headersSent) {
          sendJson(res, 400, { error: "failed to read request body" });
        } else {
          res.end();
        }
      },
    );
  });

  return { server, writer };
}

export function startLogServer(
  options: LogServerOptions = {},
): Promise<LogServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const { server, writer } = createLogServer(options);

  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      void writer?.close();
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        outPath: writer?.path ?? null,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              // Not `writer?.close().then(done)`: when `writer` is null the
              // optional chain short-circuits the whole expression and `done`
              // would never run, hanging the caller.
              if (writer === null) {
                done();
                return;
              }
              void writer.close().then(done);
            });
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

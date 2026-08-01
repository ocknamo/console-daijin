/**
 * `console-daijin-server` — the local log collector CLI.
 *
 * Argument parsing is hand-rolled to keep the package free of runtime
 * dependencies.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HEALTH_PATH,
  LOGS_PATH,
  isLoopbackHostname,
} from "./protocol";
import { startLogServer } from "./server";

const DEFAULT_OUT = ".console-daijin/logs.jsonl";

interface ParsedArgs {
  port: number;
  host: string;
  out: string | null;
  append: boolean;
  quiet: boolean;
  allowOrigins: string[];
  help: boolean;
  version: boolean;
}

function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const USAGE = `console-daijin-server — collect browser console logs from a local page

Usage
  npx console-daijin-server [options]

Options
  -p, --port <n>          Port to listen on (default: ${DEFAULT_PORT}, env: CONSOLE_DAIJIN_PORT)
      --host <addr>       Address to bind (default: ${DEFAULT_HOST})
  -o, --out <path>        JSONL output file (default: ${DEFAULT_OUT})
      --append            Append to the output file instead of truncating it
      --no-file           Do not write an output file
  -q, --quiet             Do not print logs to stdout
      --allow-origin <o>  Accept an extra origin (repeatable). Loopback origins
                          are always accepted; everything else is rejected.
  -h, --help              Show this help
  -v, --version           Show the version

Notes
  The server binds to ${DEFAULT_HOST} so it is not reachable from other machines.
  Changing --host exposes your logs to the network; only do that deliberately.
`;

/**
 * Option table for `node:util`'s parser. Everything structural — unknown
 * options, missing values, repeated `--allow-origin`, `--flag=value`, values
 * that look like another flag — is handled there, with better messages than a
 * hand-rolled loop produced. Only the value semantics are left below.
 */
const OPTIONS = {
  port: { type: "string", short: "p" },
  host: { type: "string" },
  out: { type: "string", short: "o" },
  append: { type: "boolean" },
  "no-file": { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  "allow-origin": { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  let values: {
    port?: string;
    host?: string;
    out?: string;
    append?: boolean;
    "no-file"?: boolean;
    quiet?: boolean;
    "allow-origin"?: string[];
    help?: boolean;
    version?: boolean;
  };
  try {
    ({ values } = nodeParseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const parsed: ParsedArgs = {
    port: DEFAULT_PORT,
    host: values.host ?? DEFAULT_HOST,
    out: values["no-file"] === true ? null : (values.out ?? DEFAULT_OUT),
    append: values.append === true,
    quiet: values.quiet === true,
    allowOrigins: [],
    help: values.help === true,
    version: values.version === true,
  };

  const envPort = process.env.CONSOLE_DAIJIN_PORT;
  if (envPort !== undefined && envPort !== "") {
    const port = toPort(envPort);
    if (port === null) return { error: `invalid CONSOLE_DAIJIN_PORT: ${envPort}` };
    parsed.port = port;
  }
  if (values.port !== undefined) {
    const port = toPort(values.port);
    if (port === null) return { error: `invalid port: ${values.port}` };
    parsed.port = port;
  }

  for (const raw of values["allow-origin"] ?? []) {
    const normalized = normalizeOrigin(raw);
    if (normalized === null) {
      return {
        error:
          `invalid origin: ${raw} (expected a scheme and host, such as ` +
          `https://app.example.com, or the literal "null")`,
      };
    }
    parsed.allowOrigins.push(normalized);
  }

  return parsed;
}

function toPort(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n;
}

/**
 * Origins are compared for exact equality by the server, and the format is
 * easy to get subtly wrong — a trailing slash or a missing scheme would simply
 * never match, with no error at any point. This is the one option that widens
 * a security boundary, so it gets the strictest validation, not the loosest.
 */
export function normalizeOrigin(raw: string): string | null {
  if (raw === "null") return "null";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin === "null" || url.protocol === "file:") return null;
  return url.origin;
}

/** IPv6 literals need brackets to be a valid authority in a URL. */
export function formatHostForUrl(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function banner(endpointBase: string, outPath: string | null): string {
  const lines = [
    "",
    "  console-daijin log server",
    "",
    `  endpoint  ${endpointBase}${LOGS_PATH}`,
    `  health    ${endpointBase}${HEALTH_PATH}`,
    `  file      ${outPath ?? "(disabled)"}`,
    "",
    "  client:",
    '    import { createConsoleViewer } from "console-daijin"',
    "    createConsoleViewer({ forward: true })",
    "",
    "  waiting for logs… (Ctrl+C to stop)",
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const result = parseArgs(process.argv.slice(2));

  if ("error" in result) {
    process.stderr.write(`console-daijin-server: ${result.error}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (result.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (result.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  let handle;
  try {
    handle = await startLogServer({
      port: result.port,
      host: result.host,
      out: result.out,
      append: result.append,
      quiet: result.quiet,
      allowOrigins: result.allowOrigins,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // Silently picking another port would leave the client posting into the
      // void, which is much harder to diagnose than a failed start.
      process.stderr.write(
        `console-daijin-server: port ${result.port} is already in use.\n` +
          `Start it on another port with --port <n>, and point the client at it:\n` +
          `  createConsoleViewer({ forward: { port: <n> } })\n`,
      );
    } else if (code === "EACCES") {
      process.stderr.write(
        `console-daijin-server: not allowed to bind ${result.host}:${result.port}.\n`,
      );
    } else {
      process.stderr.write(`console-daijin-server: ${(err as Error).message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    banner(`http://${formatHostForUrl(handle.host)}:${handle.port}`, handle.outPath),
  );

  // Shares one definition of "loopback" with the client and the server, rather
  // than a hand-written list that called 127.0.0.2 a network address.
  if (!isLoopbackHostname(handle.host)) {
    process.stderr.write(
      `  warning: bound to ${handle.host}; other machines on your network can post logs here.\n\n`,
    );
  }

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void handle.close().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * True only when this file was executed as a program.
 *
 * Without the guard, importing the module to test `parseArgs` or
 * `normalizeOrigin` starts a server on 5959 and creates a log file in the
 * caller's working directory — which is why none of the CLI logic had tests.
 * Compared through `realpath` so the `node_modules/.bin` symlink still counts
 * as running the program.
 */
function isRunningAsProgram(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isRunningAsProgram()) void main();

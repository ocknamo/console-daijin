import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { isAllowedHost, isAllowedOrigin, sanitizeForTerminal, startLogServer } from "../dist/server.js";

const ESC = String.fromCharCode(27);

const LOGS_PATH = "/__daijin/logs";
const HEALTH_PATH = "/__daijin/health";

function batch(entries) {
  return JSON.stringify({ v: 1, session: "test-session", entries });
}

function entry(overrides = {}) {
  return { t: Date.now(), level: "log", args: ["hello"], ...overrides };
}

describe("isAllowedOrigin", () => {
  test("accepts loopback origins on any port", () => {
    assert.equal(isAllowedOrigin("http://localhost:5173", []), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:3000", []), true);
    assert.equal(isAllowedOrigin("http://[::1]:8080", []), true);
  });

  test("accepts requests with no Origin, so curl still works", () => {
    assert.equal(isAllowedOrigin(undefined, []), true);
  });

  test("rejects remote origins", () => {
    assert.equal(isAllowedOrigin("https://evil.example", []), false);
    // A hostname that merely contains "localhost" must not pass.
    assert.equal(isAllowedOrigin("https://localhost.evil.example", []), false);
  });

  test("accepts the whole 127.0.0.0/8 loopback block", () => {
    assert.equal(isAllowedOrigin("http://127.0.0.2:5173", []), true);
    assert.equal(isAllowedOrigin("http://127.1.2.3:5173", []), true);
    assert.equal(isAllowedOrigin("http://128.0.0.1:5173", []), false);
    assert.equal(isAllowedOrigin("http://1270.0.0.1:5173", []), false);
  });

  test("rejects the opaque null origin unless explicitly allowed", () => {
    assert.equal(isAllowedOrigin("null", []), false);
    assert.equal(isAllowedOrigin("null", ["null"]), true);
  });

  test("honours the explicit allow list", () => {
    assert.equal(isAllowedOrigin("https://example.test", ["https://example.test"]), true);
  });
});

describe("isAllowedHost", () => {
  test("rejects a rebound hostname while bound to loopback", () => {
    // A hostile name resolving to 127.0.0.1 still sends its own name in Host.
    assert.equal(isAllowedHost("evil.example:5959", "127.0.0.1", []), false);
    assert.equal(isAllowedHost("localhost:5959", "127.0.0.1", []), true);
    assert.equal(isAllowedHost("127.0.0.1:5959", "127.0.0.1", []), true);
    assert.equal(isAllowedHost("[::1]:5959", "127.0.0.1", []), true);
  });

  test("steps aside when the server is deliberately exposed", () => {
    assert.equal(isAllowedHost("my-box.local:5959", "0.0.0.0", []), true);
  });

  test("accepts hosts belonging to an allow-listed origin", () => {
    assert.equal(
      isAllowedHost("app.example.test:5959", "127.0.0.1", ["https://app.example.test"]),
      true,
    );
  });
});

describe("sanitizeForTerminal", () => {
  test("neutralizes escape sequences and carriage returns", () => {
    const forged = `${ESC}[2J${ESC}[H${ESC}[31mFAKE${ESC}[0m\r00:00:00 error    injected`;
    const out = sanitizeForTerminal(forged);
    assert.doesNotMatch(out, new RegExp(ESC));
    assert.doesNotMatch(out, /\r/);
    assert.match(out, /\\x1b/);
    assert.match(out, /\\x0d/);
  });

  test("keeps newline and tab, which are load-bearing for stack traces", () => {
    assert.equal(sanitizeForTerminal("a\nb\tc"), "a\nb\tc");
  });
});

describe("log server", () => {
  let handle;
  let dir;
  let outPath;
  let base;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "console-daijin-"));
    outPath = join(dir, "logs.jsonl");
    handle = await startLogServer({
      port: 0,
      out: outPath,
      quiet: true,
      color: false,
      allowOrigins: ["https://allowed.test"],
    });
    base = `http://127.0.0.1:${handle.port}`;
  });

  after(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function readLines() {
    return readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  }

  /**
   * A 204 means "accepted", not "already on disk" — the write stream may still
   * be buffering. Polling keeps this from being a race.
   */
  async function waitForLines(count, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const lines = readLines();
      if (lines.length >= count) return lines;
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} lines, saw ${lines.length} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test("health responds", async () => {
    const res = await fetch(`${base}${HEALTH_PATH}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, v: 1 });
  });

  test("a valid batch is accepted and written as JSONL", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "POST",
      body: batch([
        entry({ level: "error", args: ["boom", "Error: x\n  at y"], stack: "Error: x\n  at y", url: "http://localhost:5173/" }),
      ]),
    });
    assert.equal(res.status, 204);

    const lines = await waitForLines(1);
    const last = lines[lines.length - 1];
    assert.equal(last.level, "error");
    assert.equal(last.session, "test-session");
    assert.equal(last.url, "http://localhost:5173/");
    assert.match(last.stack, /at y/);
    // Multi-line stacks must not break the one-record-per-line contract.
    assert.equal(readFileSync(outPath, "utf8").trim().split("\n").length, lines.length);
  });

  test("a loopback Origin is accepted and echoed back", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
      body: batch([entry()]),
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(res.headers.get("vary"), "Origin");
  });

  test("a remote Origin is rejected", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: batch([entry({ args: ["should not be stored"] })]),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      !readFileSync(outPath, "utf8").includes("should not be stored"),
      "a rejected request must not reach the log file",
    );
  });

  test("an allow-listed Origin is accepted", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "POST",
      headers: { Origin: "https://allowed.test" },
      body: batch([entry()]),
    });
    assert.equal(res.status, 204);
  });

  test("CORS preflight never answers with a wildcard", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
  });

  test("a Private Network Access preflight is answered", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-private-network"), "true");
  });

  test("the private-network header is not volunteered when unasked", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.headers.get("access-control-allow-private-network"), null);
  });

  test("malformed JSON is a 400", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, { method: "POST", body: "not json" });
    assert.equal(res.status, 400);
  });

  test("a batch failing the schema is a 400", async () => {
    for (const body of [
      JSON.stringify({ v: 99, session: "s", entries: [] }),
      JSON.stringify({ v: 1, entries: [] }),
      JSON.stringify({ v: 1, session: "s", entries: [{ level: "nope", args: [] }] }),
      JSON.stringify({ v: 1, session: "s", entries: [{ level: "log", args: [1, 2] }] }),
    ]) {
      const res = await fetch(`${base}${LOGS_PATH}`, { method: "POST", body });
      assert.equal(res.status, 400, `expected 400 for ${body}`);
    }
  });

  test("an oversized body is a 413", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "POST",
      body: batch([entry({ args: ["x".repeat(2 * 1024 * 1024)] })]),
    });
    assert.equal(res.status, 413);
  });

  test("unknown paths and methods are refused", async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const put = await fetch(`${base}${LOGS_PATH}`, { method: "PUT" });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get("allow"), "POST, OPTIONS");
  });

  test("OPTIONS on an unknown path is a 404, not a CORS grant", async () => {
    // Answering OPTIONS before checking the path told every caller that any URL
    // on this server accepts POST.
    const res = await fetch(`${base}/nope`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.status, 404);
  });

  test("a timestamp outside the Date range is refused, not silently replaced", async () => {
    for (const t of [-8_640_000_000_000_001, 1e18, Number.NaN, "now", undefined]) {
      const res = await fetch(`${base}${LOGS_PATH}`, {
        method: "POST",
        body: JSON.stringify({ v: 1, session: "s", entries: [{ t, level: "log", args: ["x"] }] }),
      });
      assert.equal(res.status, 400, `expected 400 for t=${String(t)}`);
    }
  });

  test("an unreasonable number of entries is refused", async () => {
    const res = await fetch(`${base}${LOGS_PATH}`, {
      method: "POST",
      body: batch(Array.from({ length: 1001 }, () => entry())),
    });
    assert.equal(res.status, 400);
  });

  test("page-supplied control characters cannot forge a log line", async () => {
    const lines = [];
    await withServer({ out: null, quiet: false, write: (line) => lines.push(line) }, (_h, post) =>
      post(
        batch([
          entry({ args: [`${ESC}[2J${ESC}[31mFAKE${ESC}[0m\r00:00:00 error    injected`] }),
        ]),
      ),
    );

    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], new RegExp(ESC), "an escape sequence reached the terminal");
    assert.doesNotMatch(lines[0], /\r/, "a carriage return reached the terminal");
    // The real prefix must still be the only prefix on the line.
    assert.match(lines[0], /^\d\d:\d\d:\d\d\.\d\d\d log /);
  });

  test("query strings on the logs path are tolerated", async () => {
    const res = await fetch(`${base}${LOGS_PATH}?t=1`, { method: "POST", body: batch([entry()]) });
    assert.equal(res.status, 204);
  });
});

/**
 * Runs `fn` against a throwaway server and always closes it. The `finally` is
 * the point: a failing assertion used to leave the server listening, and a
 * leaked listener is how a later run ends up posting into an earlier run's
 * output file.
 */
async function withServer(options, fn) {
  const handle = await startLogServer({ port: 0, quiet: true, color: false, ...options });
  const post = (body) =>
    fetch(`http://127.0.0.1:${handle.port}${LOGS_PATH}`, { method: "POST", body });
  try {
    return await fn(handle, post);
  } finally {
    await handle.close();
  }
}

describe("file handling", () => {
  test("the output file is truncated on start unless append is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-daijin-"));
    const out = join(dir, "logs.jsonl");
    const read = () => readFileSync(out, "utf8");

    await withServer({ out }, (_h, post) => post(batch([entry({ args: ["first run"] })])));
    assert.match(read(), /first run/);

    // A fresh run starts from an empty file...
    await withServer({ out }, () => {});
    assert.equal(read(), "");

    await withServer({ out }, (_h, post) => post(batch([entry({ args: ["kept"] })])));
    // ...unless append is set, which keeps what the previous run wrote.
    await withServer({ out, append: true }, (_h, post) =>
      post(batch([entry({ args: ["added"] })])),
    );

    assert.match(read(), /kept/);
    assert.match(read(), /added/);

    rmSync(dir, { recursive: true, force: true });
  });

  test("out: null disables file output entirely", async () => {
    await withServer({ out: null }, async (handle, post) => {
      assert.equal(handle.outPath, null);
      assert.equal((await post(batch([entry()]))).status, 204);
    });
  });

  test("rendered stdout lines carry the level and the message", async () => {
    const lines = [];
    await withServer(
      { out: null, quiet: false, write: (line) => lines.push(line) },
      (_h, post) => post(batch([entry({ level: "warn", args: ["watch out"] })])),
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /warn/);
    assert.match(lines[0], /watch out/);
    // Colour disabled means no escape sequences.
    assert.doesNotMatch(lines[0], /\u001b\[/);
  });
});

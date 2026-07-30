import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { isAllowedOrigin, startLogServer } from "../dist/server.js";

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

  test("rejects the opaque null origin unless explicitly allowed", () => {
    assert.equal(isAllowedOrigin("null", []), false);
    assert.equal(isAllowedOrigin("null", ["null"]), true);
  });

  test("honours the explicit allow list", () => {
    assert.equal(isAllowedOrigin("https://example.test", ["https://example.test"]), true);
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

    const lines = readLines();
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
    assert.equal((await fetch(`${base}${LOGS_PATH}`, { method: "PUT" })).status, 405);
  });

  test("query strings on the logs path are tolerated", async () => {
    const res = await fetch(`${base}${LOGS_PATH}?t=1`, { method: "POST", body: batch([entry()]) });
    assert.equal(res.status, 204);
  });
});

describe("file handling", () => {
  test("the output file is truncated on start unless append is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-daijin-"));
    const outPath = join(dir, "logs.jsonl");

    const first = await startLogServer({ port: 0, out: outPath, quiet: true, color: false });
    await fetch(`http://127.0.0.1:${first.port}${LOGS_PATH}`, {
      method: "POST",
      body: batch([entry({ args: ["from first run"] })]),
    });
    await first.close();
    assert.match(readFileSync(outPath, "utf8"), /from first run/);

    const second = await startLogServer({ port: 0, out: outPath, quiet: true, color: false });
    await second.close();
    assert.equal(readFileSync(outPath, "utf8"), "");

    const third = await startLogServer({ port: 0, out: outPath, quiet: true, color: false });
    await fetch(`http://127.0.0.1:${third.port}${LOGS_PATH}`, {
      method: "POST",
      body: batch([entry({ args: ["kept"] })]),
    });
    await third.close();

    // Starting with append keeps what the previous run wrote.
    const fourth = await startLogServer({
      port: 0,
      out: outPath,
      append: true,
      quiet: true,
      color: false,
    });
    await fetch(`http://127.0.0.1:${fourth.port}${LOGS_PATH}`, {
      method: "POST",
      body: batch([entry({ args: ["added"] })]),
    });
    await fourth.close();

    const contents = readFileSync(outPath, "utf8");
    assert.match(contents, /kept/);
    assert.match(contents, /added/);

    rmSync(dir, { recursive: true, force: true });
  });

  test("out: null disables file output entirely", async () => {
    const handle = await startLogServer({ port: 0, out: null, quiet: true, color: false });
    assert.equal(handle.outPath, null);
    const res = await fetch(`http://127.0.0.1:${handle.port}${LOGS_PATH}`, {
      method: "POST",
      body: batch([entry()]),
    });
    assert.equal(res.status, 204);
    await handle.close();
  });

  test("rendered stdout lines carry the level and the message", async () => {
    const lines = [];
    const handle = await startLogServer({
      port: 0,
      out: null,
      color: false,
      write: (line) => lines.push(line),
    });
    await fetch(`http://127.0.0.1:${handle.port}${LOGS_PATH}`, {
      method: "POST",
      body: batch([entry({ level: "warn", args: ["watch out"] })]),
    });
    await handle.close();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /warn/);
    assert.match(lines[0], /watch out/);
    // Colour disabled means no escape sequences.
    assert.doesNotMatch(lines[0], /\u001b\[/);
  });
});

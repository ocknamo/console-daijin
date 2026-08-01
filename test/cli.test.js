import assert from "node:assert/strict";
import { describe, test } from "node:test";

// Importable only because cli.ts guards `main()` behind an is-this-the-program
// check. Without it, this import would start a server and write a log file.
const { formatHostForUrl, normalizeOrigin, parseArgs } = await import("../dist/cli.js");

describe("normalizeOrigin", () => {
  test("normalizes to a bare origin", () => {
    // The server compares origins for exact equality, so a trailing slash
    // would simply never match and never say why.
    assert.equal(normalizeOrigin("https://app.example.com/"), "https://app.example.com");
    assert.equal(normalizeOrigin("https://app.example.com"), "https://app.example.com");
    assert.equal(normalizeOrigin("http://localhost:5173/some/path"), "http://localhost:5173");
    assert.equal(normalizeOrigin("https://app.example.com:443/"), "https://app.example.com");
  });

  test("rejects anything that is not an origin", () => {
    assert.equal(normalizeOrigin("app.example.com"), null);
    assert.equal(normalizeOrigin(""), null);
    assert.equal(normalizeOrigin("not a url"), null);
    assert.equal(normalizeOrigin("file:///tmp/x.html"), null);
  });

  test("passes the literal null through for file:// pages", () => {
    assert.equal(normalizeOrigin("null"), "null");
  });
});

describe("formatHostForUrl", () => {
  test("brackets IPv6 literals so the banner URL is usable", () => {
    assert.equal(formatHostForUrl("::1"), "[::1]");
    assert.equal(formatHostForUrl("fe80::1"), "[fe80::1]");
    assert.equal(formatHostForUrl("[::1]"), "[::1]");
  });

  test("shows a connectable host for wildcard binds", () => {
    assert.equal(formatHostForUrl("0.0.0.0"), "localhost");
    assert.equal(formatHostForUrl("::"), "localhost");
  });

  test("leaves ordinary hosts alone", () => {
    assert.equal(formatHostForUrl("127.0.0.1"), "127.0.0.1");
    assert.equal(formatHostForUrl("localhost"), "localhost");
  });
});

describe("parseArgs", () => {
  test("defaults", () => {
    const parsed = parseArgs([]);
    assert.equal(parsed.port, 5959);
    assert.equal(parsed.host, "127.0.0.1");
    assert.equal(parsed.out, ".console-daijin/logs.jsonl");
    assert.equal(parsed.append, false);
    assert.equal(parsed.quiet, false);
    assert.deepEqual(parsed.allowOrigins, []);
  });

  test("accepts both spaced and inline values", () => {
    assert.equal(parseArgs(["--port", "1234"]).port, 1234);
    assert.equal(parseArgs(["--port=1234"]).port, 1234);
    assert.equal(parseArgs(["-p", "1234"]).port, 1234);
  });

  test("refuses a value that is really the next flag", () => {
    // `--out --quiet` used to create a file literally named "--quiet".
    // The message comes from node:util now, so assert the behaviour and that
    // the offending option is named, not the exact wording.
    for (const argv of [["--out", "--quiet"], ["--out"], ["--allow-origin", "-q"]]) {
      const result = parseArgs(argv);
      assert.ok("error" in result, `expected ${argv.join(" ")} to be rejected`);
      assert.match(result.error, /--out|--allow-origin/);
    }
  });

  test("rejects stray positional arguments", () => {
    assert.ok("error" in parseArgs(["logs.jsonl"]));
  });

  test("rejects invalid ports", () => {
    for (const bad of ["abc", "-1", "70000", "1.5"]) {
      assert.ok("error" in parseArgs(["--port", bad]), `expected ${bad} to be rejected`);
    }
  });

  test("rejects an unknown option instead of ignoring it", () => {
    const result = parseArgs(["--nope"]);
    assert.ok("error" in result);
    assert.match(result.error, /--nope/);
  });

  test("validates and normalizes --allow-origin", () => {
    assert.deepEqual(parseArgs(["--allow-origin", "https://app.example.com/"]).allowOrigins, [
      "https://app.example.com",
    ]);
    assert.ok("error" in parseArgs(["--allow-origin", "app.example.com"]));
  });

  test("--allow-origin is repeatable", () => {
    const parsed = parseArgs([
      "--allow-origin",
      "https://a.example",
      "--allow-origin",
      "https://b.example",
    ]);
    assert.deepEqual(parsed.allowOrigins, ["https://a.example", "https://b.example"]);
  });

  test("--no-file disables output and --out sets it", () => {
    assert.equal(parseArgs(["--no-file"]).out, null);
    assert.equal(parseArgs(["--out", "logs.jsonl"]).out, "logs.jsonl");
  });

  test("flags without values", () => {
    const parsed = parseArgs(["--append", "-q"]);
    assert.equal(parsed.append, true);
    assert.equal(parsed.quiet, true);
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-v"]).version, true);
  });

  test("a path that begins with a dash is still reachable inline", () => {
    assert.equal(parseArgs(["--out=-weird-name.jsonl"]).out, "-weird-name.jsonl");
  });
});

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

describe("parseArgs defaults", () => {
  test("are the documented ones", () => {
    assert.deepEqual(parseArgs([]), {
      port: 5959,
      host: "127.0.0.1",
      out: ".console-daijin/logs.jsonl",
      append: false,
      quiet: false,
      allowOrigins: [],
      help: false,
      version: false,
    });
  });
});

// Parsing itself is node:util's job; the option table is ours. Each row pins
// something that a typo in that table would break — a missing option, a wrong
// type, a dropped short form, a mapping to the wrong field. Verified by
// mutation: removing `short: "q"`, dropping `host`, dropping `multiple: true`
// or inverting the `no-file` mapping each fails at least one row.
//
// Cases that only exercise node:util's own parsing are deliberately absent.
// `--port=1234` and `--out=-leading-dash.jsonl` were here and were removed:
// with them gone, every one of those mutations is still caught, so they were
// testing the standard library and nothing else.
describe("the option table", () => {
  const cases = [
    [["--port", "1234"], { port: 1234 }],
    [["-p", "1234"], { port: 1234 }],
    [["--host", "0.0.0.0"], { host: "0.0.0.0" }],
    [["--out", "logs.jsonl"], { out: "logs.jsonl" }],
    [["-o", "logs.jsonl"], { out: "logs.jsonl" }],
    [["--no-file"], { out: null }],
    [["--append"], { append: true }],
    [["--quiet"], { quiet: true }],
    [["-q"], { quiet: true }],
    [["--help"], { help: true }],
    [["-h"], { help: true }],
    [["--version"], { version: true }],
    [["-v"], { version: true }],
    [
      ["--allow-origin", "https://a.example", "--allow-origin", "https://b.example"],
      { allowOrigins: ["https://a.example", "https://b.example"] },
    ],
  ];

  for (const [argv, expected] of cases) {
    test(argv.join(" "), () => {
      const parsed = parseArgs(argv);
      assert.ok(!("error" in parsed), `unexpected error: ${parsed.error}`);
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(parsed[key], value);
      }
    });
  }
});

describe("what parseArgs validates itself", () => {
  test("rejects a port outside the valid range", () => {
    for (const bad of ["abc", "-1", "70000", "1.5"]) {
      assert.ok("error" in parseArgs(["--port", bad]), `expected ${bad} to be rejected`);
    }
  });

  test("normalizes an origin, and refuses one it cannot", () => {
    // The server compares origins for exact equality, so an un-normalized
    // value would never match and never say why.
    assert.deepEqual(parseArgs(["--allow-origin", "https://app.example.com/"]).allowOrigins, [
      "https://app.example.com",
    ]);
    assert.ok("error" in parseArgs(["--allow-origin", "app.example.com"]));
  });

  test("surfaces the parser's own refusals rather than swallowing them", () => {
    // `--out --quiet` must not create a file named "--quiet"; an unknown
    // option must not be ignored. node:util decides, we must not discard it.
    for (const argv of [["--out", "--quiet"], ["--out"], ["--nope"], ["logs.jsonl"]]) {
      assert.ok("error" in parseArgs(argv), `expected ${argv.join(" ")} to be rejected`);
    }
  });
});

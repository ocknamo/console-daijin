import assert from "node:assert/strict";
import { test } from "node:test";

import { serializeArg, serializeArgs } from "../dist/index.js";

test("errors keep their message and stack instead of collapsing to {}", () => {
  const out = serializeArg(new Error("boom"));
  assert.notEqual(out, "{}");
  assert.match(out, /Error: boom/);
  assert.match(out, /at /, "expected a stack trace in the output");
});

test("error subclasses report their own name", () => {
  class NotFoundError extends Error {
    constructor(message) {
      super(message);
      this.name = "NotFoundError";
    }
  }
  assert.match(serializeArg(new NotFoundError("nope")), /NotFoundError: nope/);
});

test("own enumerable error properties are included", () => {
  const err = new Error("failed");
  err.code = "E_TEST";
  assert.match(serializeArg(err), /code: "E_TEST"/);
});

test("error causes are followed", () => {
  const err = new Error("outer", { cause: new Error("inner") });
  const out = serializeArg(err);
  assert.match(out, /outer/);
  assert.match(out, /\[cause\]/);
  assert.match(out, /inner/);
});

test("aggregated errors are listed", () => {
  const err = new AggregateError([new Error("a"), new Error("b")], "both failed");
  const out = serializeArg(err);
  assert.match(out, /both failed/);
  assert.match(out, /a/);
  assert.match(out, /b/);
});

test("circular references do not throw", () => {
  const obj = { name: "root" };
  obj.self = obj;
  const out = serializeArg(obj);
  assert.match(out, /\[Circular\]/);
  assert.match(out, /name: "root"/);
});

test("a value referenced twice is not mistaken for a cycle", () => {
  const shared = { id: 1 };
  const out = serializeArg({ a: shared, b: shared });
  assert.doesNotMatch(out, /\[Circular\]/);
});

test("cycle detection covers errors too", () => {
  // Errors were returned before being added to the `seen` set, so the one type
  // this module handles specially was the one type with no cycle detection.
  const err = new Error("boom");
  err.self = err;
  const out = serializeArg(err, { maxLength: 100_000 });
  assert.match(out, /\[Circular\]/);
  assert.equal((out.match(/boom/g) ?? []).length, 1);
});

test("mutually referencing causes terminate instead of unrolling", () => {
  // `new Error(msg, { cause })` re-throw wrappers produce these in real code.
  const a = new Error("A");
  const b = new Error("B");
  a.cause = b;
  b.cause = a;
  const out = serializeArg(a, { maxLength: 100_000 });
  assert.equal((out.match(/Error: A/g) ?? []).length, 1);
  assert.equal((out.match(/Error: B/g) ?? []).length, 1);
  assert.match(out, /\[Circular\]/);
});

test("an own enumerable name is not repeated in the extras", () => {
  const err = new Error("x");
  Object.assign(err, { name: "Custom" });
  const out = serializeArg(err);
  assert.match(out, /Custom: x/);
  assert.doesNotMatch(out, /\{ name:/);
});

test("nesting deeper than maxDepth collapses", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.match(serializeArg(deep, { maxDepth: 2 }), /\[Object\]/);
});

test("long output is truncated with a marker", () => {
  const out = serializeArg("x".repeat(100), { maxLength: 50 });
  assert.equal(out.length, 50);
  assert.ok(out.startsWith("x".repeat(20)));
  assert.match(out, /truncated/);
});

test("maxLength is a hard cap, suffix included", () => {
  // The JSDoc calls it a cap per argument, so it has to hold for every input,
  // not just the ones where the suffix happens to fit.
  for (const maxLength of [1, 5, 13, 14, 50, 1000]) {
    for (const value of ["x".repeat(5000), { a: "y".repeat(5000) }, [1, 2, 3]]) {
      const out = serializeArg(value, { maxLength });
      assert.ok(
        out.length <= maxLength,
        `maxLength=${maxLength} produced ${out.length} chars`,
      );
    }
  }
});

test("traversal stops at the budget instead of walking the whole tree", () => {
  // Building the string first and trimming afterwards bounded the result but
  // not the work: width 100 x depth 4 is 1e8 nodes, which froze the page for
  // ~35s to produce 10 KB of output. Capture runs synchronously inside
  // console.log, so that is the tab locking up.
  const wide = (depth, width) =>
    depth === 0 ? "a" : Array.from({ length: width }, () => wide(depth - 1, width));

  // Built outside the timer: constructing the fixture is itself expensive, and
  // only the serialization cost is under test here.
  const fixture = wide(4, 50);

  const started = performance.now();
  const out = serializeArg(fixture);
  const elapsed = performance.now() - started;

  assert.ok(out.length <= 10_000);
  // 50^4 is 6.25M nodes; the old implementation walked all of them, taking
  // seconds. Stopping at the budget puts this in the low milliseconds.
  assert.ok(elapsed < 250, `serialization took ${elapsed.toFixed(0)}ms`);
});

test("maxNodes bounds traversal independently of the character budget", () => {
  const out = serializeArg(Array.from({ length: 100 }, () => ({ a: 1 })), { maxNodes: 5 });
  assert.match(out, /truncated/);
});

test("top-level strings print raw and nested strings print quoted", () => {
  assert.equal(serializeArg("hello"), "hello");
  assert.equal(serializeArg({ k: "hello" }), '{ k: "hello" }');
});

test("primitives that JSON.stringify cannot handle are covered", () => {
  assert.equal(serializeArg(undefined), "undefined");
  assert.equal(serializeArg(null), "null");
  assert.equal(serializeArg(10n), "10n");
  assert.equal(serializeArg(Symbol("s")), "Symbol(s)");
  assert.equal(serializeArg(Number.NaN), "NaN");
  assert.equal(serializeArg(-0), "-0");
});

test("functions are named", () => {
  function namedFn() {}
  assert.equal(serializeArg(namedFn), "[Function: namedFn]");
  assert.equal(
    serializeArg(function () {}),
    "[Function (anonymous)]",
  );
});

test("collections are summarized with their size", () => {
  assert.match(serializeArg(new Map([["a", 1]])), /Map\(1\)/);
  assert.match(serializeArg(new Set([1, 2])), /Set\(2\)/);
  assert.equal(serializeArg([1, "two", true]), '[1, "two", true]');
});

test("class instances keep their constructor name", () => {
  class Point {
    constructor() {
      this.x = 1;
    }
  }
  assert.equal(serializeArg(new Point()), "Point { x: 1 }");
});

test("a throwing getter is reported rather than propagated", () => {
  const obj = {
    get boom() {
      throw new Error("nope");
    },
  };
  assert.match(serializeArg(obj), /\[getter threw\]/);
});

test("large collections stop after a bounded number of entries", () => {
  const out = serializeArg(Array.from({ length: 500 }, (_, i) => i));
  assert.match(out, /more\]$/);
});

test("serializeArgs maps every argument", () => {
  assert.deepEqual(serializeArgs(["a", 1, null]), ["a", "1", "null"]);
});

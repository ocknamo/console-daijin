import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { serializeArg, serializeArgs } from "../dist/index.js";

// Output is JSON-shaped, not console-shaped: this exists to give an agent
// something readable enough to debug from, not to reproduce DevTools. Tests
// therefore assert the contract — nothing throws, nothing hangs, nothing
// important is silently lost — rather than exact punctuation.

describe("errors", () => {
  test("keep their message and stack instead of collapsing to {}", () => {
    const out = serializeArg(new Error("boom"));
    assert.notEqual(out, "{}");
    assert.match(out, /Error: boom/);
    assert.match(out, /at /, "expected a stack trace in the output");
  });

  test("nested in an object, still keep their stack", () => {
    const out = serializeArg({ failure: new Error("inner boom") });
    assert.match(out, /inner boom/);
    assert.match(out, /at /);
  });

  test("subclasses report their own name", () => {
    class NotFoundError extends Error {
      constructor(message) {
        super(message);
        this.name = "NotFoundError";
      }
    }
    const out = serializeArg(new NotFoundError("nope"));
    assert.match(out, /NotFoundError: nope/);
    // `name` is own-enumerable here, but it is already in the head.
    assert.doesNotMatch(out, /"name":/);
  });

  test("keep the extra properties worth acting on", () => {
    const err = new Error("failed");
    err.code = "ECONNREFUSED";
    err.status = 503;
    const out = serializeArg(err);
    assert.match(out, /ECONNREFUSED/);
    assert.match(out, /503/);
  });

  test("follow the cause chain", () => {
    const out = serializeArg(new Error("outer", { cause: new Error("inner") }));
    assert.match(out, /outer/);
    assert.match(out, /\[cause\]/);
    assert.match(out, /inner/);
  });

  test("terminate on a cause cycle", () => {
    // `new Error(msg, { cause })` re-throw wrappers produce these in real code,
    // and following one unbounded is an infinite recursion.
    const a = new Error("A");
    const b = new Error("B");
    a.cause = b;
    b.cause = a;
    const out = serializeArg(a, { maxLength: 1_000_000 });
    assert.ok(out.length < 100_000, `runaway expansion: ${out.length} chars`);
    assert.match(out, /Error: A/);
    assert.match(out, /Error: B/);
  });

  test("terminate when the cycle runs through a plain object", () => {
    const err = new Error("boom");
    err.context = { err };
    const out = serializeArg(err, { maxLength: 1_000_000 });
    assert.ok(out.length < 100_000, `runaway expansion: ${out.length} chars`);
    assert.match(out, /\[Circular\]/);
  });

  test("a self-referencing error terminates", () => {
    const err = new Error("boom");
    err.self = err;
    const out = serializeArg(err, { maxLength: 1_000_000 });
    assert.ok(out.length < 100_000, `runaway expansion: ${out.length} chars`);
  });
});

describe("values JSON.stringify cannot handle", () => {
  test("primitives that would be dropped or thrown on", () => {
    assert.equal(serializeArg(undefined), "undefined");
    assert.equal(serializeArg(null), "null");
    assert.equal(serializeArg(10n), "10n");
    assert.equal(serializeArg(Symbol("s")), "Symbol(s)");
    assert.equal(serializeArg(Number.NaN), "NaN");
    assert.equal(serializeArg(-0), "-0");
    assert.equal(serializeArg(Number.POSITIVE_INFINITY), "Infinity");
  });

  test("the same values nested, where JSON.stringify would drop or throw", () => {
    const out = serializeArg({ big: 1n, fn() {}, sym: Symbol("s"), gone: undefined, nan: NaN });
    assert.match(out, /1n/);
    assert.match(out, /Function/);
    assert.match(out, /Symbol\(s\)/);
    assert.match(out, /undefined/);
    assert.match(out, /NaN/);
  });

  test("functions are named", () => {
    function namedFn() {}
    assert.equal(serializeArg(namedFn), "[Function: namedFn]");
    assert.equal(serializeArg(function () {}), "[Function (anonymous)]");
  });

  test("circular references do not throw", () => {
    const obj = { name: "root" };
    obj.self = obj;
    const out = serializeArg(obj);
    assert.match(out, /\[Circular\]/);
    assert.match(out, /root/);
  });

  test("a throwing getter degrades instead of propagating", () => {
    const obj = {
      get boom() {
        throw new Error("nope");
      },
    };
    assert.doesNotThrow(() => serializeArg(obj));
  });
});

describe("shapes", () => {
  test("collections report their size", () => {
    assert.match(serializeArg(new Map([["a", 1]])), /Map\(1\)/);
    assert.match(serializeArg(new Set([1, 2])), /Set\(2\)/);
  });

  test("dates and regexes are readable", () => {
    assert.equal(serializeArg(new Date(0)), "1970-01-01T00:00:00.000Z");
    assert.equal(serializeArg(new Date(Number.NaN)), "Invalid Date");
    assert.equal(serializeArg(/ab+c/gi), "/ab+c/gi");
  });

  test("top-level strings print raw", () => {
    assert.equal(serializeArg("hello"), "hello");
  });

  test("arrays and objects keep their contents", () => {
    assert.equal(serializeArg([1, "two", true]), '[1,"two",true]');
    assert.match(serializeArg({ k: "hello" }), /hello/);
  });

  test("wide collections are clipped with a count of what was left out", () => {
    const array = serializeArg(Array.from({ length: 500 }, (_, i) => i));
    assert.match(array, /470 more/);

    const object = {};
    for (let i = 0; i < 500; i++) object[`k${i}`] = i;
    assert.match(serializeArg(object), /470 more/);
  });
});

describe("bounds", () => {
  test("traversal is bounded even for a structure that would take minutes", () => {
    // Walking this shape without bounds took ~48s and produced 195 MB. Capture
    // runs synchronously inside console.log, so that is the tab locking up.
    const wide = (depth, width) =>
      depth === 0 ? "a" : Array.from({ length: width }, () => wide(depth - 1, width));
    const fixture = wide(4, 100);

    const started = performance.now();
    const out = serializeArg(fixture);
    const elapsed = performance.now() - started;

    assert.ok(out.length <= 10_000);
    assert.ok(elapsed < 250, `serialization took ${elapsed.toFixed(0)}ms`);
  });

  test("a single enormous array is bounded too", () => {
    const started = performance.now();
    serializeArg(Array.from({ length: 1_000_000 }, (_, i) => i));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `serialization took ${elapsed.toFixed(0)}ms`);
  });

  test("maxLength is a hard cap for every input", () => {
    const deep = { a: { b: { c: { d: { e: "x".repeat(5000) } } } } };
    for (const maxLength of [0, 1, 5, 50, 1000]) {
      for (const value of ["x".repeat(5000), deep, [1, 2, 3], new Error("boom")]) {
        const out = serializeArg(value, { maxLength });
        assert.ok(out.length <= maxLength, `maxLength=${maxLength} gave ${out.length} chars`);
      }
    }
  });

  test("maxNodes collapses the remainder rather than dropping it", () => {
    const out = serializeArg(
      Array.from({ length: 20 }, () => ({ a: 1, b: 2, c: 3 })),
      { maxNodes: 5 },
    );
    assert.match(out, /…/);
    assert.ok(out.length < 500);
  });

  test("long output is marked as truncated", () => {
    const out = serializeArg("x".repeat(100), { maxLength: 50 });
    assert.equal(out.length, 50);
    assert.ok(out.startsWith("x".repeat(20)));
    assert.ok(out.endsWith("…"));
  });
});

test("serializeArgs maps every argument", () => {
  assert.deepEqual(serializeArgs(["a", 1, null]), ["a", "1", "null"]);
});

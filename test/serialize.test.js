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

test("nesting deeper than maxDepth collapses", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.match(serializeArg(deep, { maxDepth: 2 }), /\[Object\]/);
});

test("long output is truncated with a marker", () => {
  const out = serializeArg("x".repeat(100), { maxLength: 10 });
  assert.equal(out.slice(0, 10), "x".repeat(10));
  assert.match(out, /truncated 90 chars/);
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

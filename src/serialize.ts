/**
 * Safe value-to-string conversion for log arguments.
 *
 * `JSON.stringify` is not usable here: it turns `Error` into `{}` because
 * `message` and `stack` are non-enumerable, and it throws on circular
 * references and `BigInt`. Losing the stack trace is the whole point of a log
 * line for an error, so errors get first-class handling below.
 *
 * Output is written into a sink with a running character budget rather than
 * being built and then trimmed. That distinction matters: trimming afterwards
 * bounds the *result* but not the *work*, and `console.log` of a wide, shallow
 * structure (an API response, a React internal tree) would walk every node
 * before the cap applied. Since capture runs synchronously inside
 * `console.log`, that is a frozen page — a debugger that hangs the thing being
 * debugged. Traversal now stops the moment the budget runs out.
 *
 * This module must stay usable outside a browser (the test suite runs it under
 * Node), so every DOM reference is guarded with `typeof`.
 */

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_LENGTH = 10_000;
/** Belt-and-braces bound on traversal, independent of the character budget. */
const DEFAULT_MAX_NODES = 20_000;

/** Per-collection cap, so one huge array cannot build a giant string. */
const MAX_ENTRIES = 100;

const TRUNCATION_SUFFIX = "…(truncated)";

/** Thrown to unwind the traversal once a budget is exhausted. */
const BUDGET_EXHAUSTED = Symbol("console-daijin.budget");

export interface SerializeOptions {
  /** Nesting levels to walk before collapsing to `[Object]`. Default 4. */
  maxDepth?: number;
  /** Hard cap on the returned string, suffix included. Default 10000. */
  maxLength?: number;
  /** Hard cap on visited nodes. Default 20000. */
  maxNodes?: number;
}

interface Sink {
  parts: string[];
  /** Characters still allowed. */
  remaining: number;
  /** Node visits still allowed. */
  nodes: number;
  maxDepth: number;
  seen: Set<object>;
}

export function serializeArgs(
  args: readonly unknown[],
  options: SerializeOptions = {},
): string[] {
  return args.map((arg) => serializeArg(arg, options));
}

export function serializeArg(value: unknown, options: SerializeOptions = {}): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  const sink: Sink = {
    parts: [],
    // Reserve room for the suffix so the documented cap is the real cap.
    remaining: Math.max(0, maxLength - TRUNCATION_SUFFIX.length),
    nodes: maxNodes,
    maxDepth,
    seen: new Set<object>(),
  };

  let truncated = false;
  try {
    write(value, 0, sink);
  } catch (err) {
    if (err === BUDGET_EXHAUSTED) {
      truncated = true;
    } else {
      // A throwing getter or exotic proxy should never take down the caller.
      try {
        return clamp(String(value), maxLength);
      } catch {
        return "[unserializable]";
      }
    }
  }

  const out = sink.parts.join("");
  return clamp(truncated ? out + TRUNCATION_SUFFIX : out, maxLength);
}

/** Stack of the first `Error` among the arguments, for `LogEntry.stack`. */
export function firstErrorStack(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error && typeof arg.stack === "string" && arg.stack !== "") {
      return arg.stack;
    }
  }
  return undefined;
}

function clamp(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function push(sink: Sink, text: string): void {
  if (text.length > sink.remaining) {
    sink.parts.push(text.slice(0, sink.remaining));
    sink.remaining = 0;
    throw BUDGET_EXHAUSTED;
  }
  sink.parts.push(text);
  sink.remaining -= text.length;
}

function enter(sink: Sink): void {
  if (--sink.nodes < 0) throw BUDGET_EXHAUSTED;
}

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function isDomNode(value: unknown): value is Node {
  return typeof Node !== "undefined" && value instanceof Node;
}

function describeElement(el: Element): string {
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  const className = el.getAttribute("class");
  if (className && className.trim() !== "") {
    out += className
      .trim()
      .split(/\s+/)
      .map((c) => `.${c}`)
      .join("");
  }
  return `<${out}>`;
}

function constructorName(obj: object): string | undefined {
  const name = obj.constructor?.name;
  return name && name !== "Object" ? name : undefined;
}

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function write(value: unknown, depth: number, sink: Sink): void {
  enter(sink);

  if (value === null) return push(sink, "null");
  if (value === undefined) return push(sink, "undefined");

  switch (typeof value) {
    case "string":
      // Top-level strings print raw, like the console does; nested ones quoted.
      return push(sink, depth === 0 ? value : JSON.stringify(value));
    case "number":
      return push(sink, Object.is(value, -0) ? "-0" : String(value));
    case "boolean":
      return push(sink, String(value));
    case "bigint":
      return push(sink, `${value}n`);
    case "symbol":
      return push(sink, String(value));
    case "function": {
      const name = (value as (...args: unknown[]) => unknown).name;
      return push(sink, name ? `[Function: ${name}]` : "[Function (anonymous)]");
    }
  }

  const obj = value as object;

  // Only the current path is tracked, so a value referenced twice in a tree is
  // printed twice rather than being mislabelled as circular.
  if (sink.seen.has(obj)) return push(sink, "[Circular]");

  if (value instanceof Error) return writeError(value, depth, sink);
  if (isElement(value)) return push(sink, describeElement(value));
  if (isDomNode(value)) return push(sink, `[${value.nodeName}]`);
  if (value instanceof Date) {
    return push(sink, Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString());
  }
  if (value instanceof RegExp) return push(sink, String(value));

  if (depth >= sink.maxDepth) {
    return push(sink, Array.isArray(value) ? "[Array]" : `[${constructorName(obj) ?? "Object"}]`);
  }

  sink.seen.add(obj);
  try {
    if (Array.isArray(value)) return writeArray(value, depth, sink);
    if (typeof Map !== "undefined" && value instanceof Map) return writeMap(value, depth, sink);
    if (typeof Set !== "undefined" && value instanceof Set) return writeSet(value, depth, sink);
    return writePlainObject(obj, depth, sink);
  } finally {
    sink.seen.delete(obj);
  }
}

function writeOverflow(sink: Sink, total: number, shown: number): void {
  if (total > shown) push(sink, `, …${total - shown} more`);
}

function writeArray(arr: readonly unknown[], depth: number, sink: Sink): void {
  push(sink, "[");
  const shown = Math.min(arr.length, MAX_ENTRIES);
  for (let i = 0; i < shown; i++) {
    if (i > 0) push(sink, ", ");
    write(arr[i], depth + 1, sink);
  }
  writeOverflow(sink, arr.length, shown);
  push(sink, "]");
}

function writeMap(map: Map<unknown, unknown>, depth: number, sink: Sink): void {
  push(sink, `Map(${map.size}) {`);
  let shown = 0;
  for (const [key, value] of map) {
    if (shown >= MAX_ENTRIES) break;
    push(sink, shown === 0 ? " " : ", ");
    write(key, depth + 1, sink);
    push(sink, " => ");
    write(value, depth + 1, sink);
    shown++;
  }
  writeOverflow(sink, map.size, shown);
  push(sink, shown > 0 ? " }" : "}");
}

function writeSet(set: Set<unknown>, depth: number, sink: Sink): void {
  push(sink, `Set(${set.size}) {`);
  let shown = 0;
  for (const value of set) {
    if (shown >= MAX_ENTRIES) break;
    push(sink, shown === 0 ? " " : ", ");
    write(value, depth + 1, sink);
    shown++;
  }
  writeOverflow(sink, set.size, shown);
  push(sink, shown > 0 ? " }" : "}");
}

function writePlainObject(obj: object, depth: number, sink: Sink): void {
  const prefix = constructorName(obj);
  if (prefix !== undefined) push(sink, `${prefix} `);

  const keys = Object.keys(obj);
  if (keys.length === 0) return push(sink, "{}");

  push(sink, "{");
  const shown = Math.min(keys.length, MAX_ENTRIES);
  for (let i = 0; i < shown; i++) {
    push(sink, i === 0 ? " " : ", ");
    const key = keys[i];
    push(sink, `${isIdentifier(key) ? key : JSON.stringify(key)}: `);
    writeProperty(obj, key, depth + 1, sink);
  }
  writeOverflow(sink, keys.length, shown);
  push(sink, " }");
}

/** Reads the property inside the guard, then writes outside it, so a budget
 *  unwind is never mistaken for a throwing accessor. */
function writeProperty(obj: object, key: string, depth: number, sink: Sink): void {
  let value: unknown;
  try {
    value = (obj as Record<string, unknown>)[key];
  } catch {
    return push(sink, "[getter threw]");
  }
  write(value, depth, sink);
}

function writeError(err: Error, depth: number, sink: Sink): void {
  // Errors take part in cycle detection like any other object. Without this,
  // `a.cause = b; b.cause = a` expands a stack trace per level until maxDepth
  // stops it — in the one type this module claims to handle properly.
  sink.seen.add(err);
  try {
    const name = err.name || "Error";
    const message = typeof err.message === "string" ? err.message : "";
    const head = message ? `${name}: ${message}` : name;

    const stack = typeof err.stack === "string" ? err.stack : "";
    // V8 stacks already start with "Name: message"; Firefox and Safari do not.
    push(sink, stack === "" ? head : stack.startsWith(name) ? stack : `${head}\n${stack}`);

    // `name` joins `stack` and `message` in the exclusion list: subclasses that
    // assign `this.name` make it own-enumerable, and it is already in the head.
    // `cause` likewise — assigning it after construction (rather than via the
    // constructor option) makes it own-enumerable, and it has its own section
    // below, so without this it is rendered twice.
    const extras = Object.keys(err).filter(
      (key) => key !== "stack" && key !== "message" && key !== "name" && key !== "cause",
    );
    if (extras.length > 0 && depth < sink.maxDepth) {
      push(sink, "\n  { ");
      for (let i = 0; i < extras.length; i++) {
        if (i > 0) push(sink, ", ");
        push(sink, `${extras[i]}: `);
        writeProperty(err, extras[i], depth + 1, sink);
      }
      push(sink, " }");
    }

    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && depth < sink.maxDepth) {
      push(sink, "\n  [cause] ");
      write(cause, depth + 1, sink);
    }

    // Duck-typed rather than `instanceof AggregateError`, which would require a
    // newer `lib` than the browser build targets. `errors` is non-enumerable, so
    // it is not covered by the extras above.
    const aggregated = (err as { errors?: unknown }).errors;
    if (Array.isArray(aggregated) && depth < sink.maxDepth) {
      const shown = Math.min(aggregated.length, MAX_ENTRIES);
      for (let i = 0; i < shown; i++) {
        push(sink, "\n  [error] ");
        write(aggregated[i], depth + 1, sink);
      }
    }
  } finally {
    sink.seen.delete(err);
  }
}

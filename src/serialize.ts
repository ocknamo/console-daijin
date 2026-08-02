/**
 * Value-to-string conversion for log arguments.
 *
 * The engine is `JSON.stringify` with a replacer, rather than a hand-written
 * tree walker. `JSON.stringify` alone is unusable — it turns `Error` into `{}`
 * because `message` and `stack` are non-enumerable, throws on circular
 * references and `BigInt`, and silently drops functions — but a replacer fixes
 * each of those in a line or two, and the traversal itself runs in native code.
 *
 * Two bounds keep it from freezing the page. Capture runs synchronously inside
 * `console.log`, so an unbounded walk of a wide, deep object is the tab locking
 * up, which is a poor trait for a debugging tool:
 *
 *  - Fan-out is clipped to `MAX_ITEMS` per array or object *before*
 *    `JSON.stringify` descends into it, so no level is ever wide.
 *  - A node budget turns everything past `maxNodes` into an ellipsis, so no
 *    shape can be deep enough to matter.
 *
 * Output is JSON-shaped rather than console-shaped. This module exists to give
 * a coding agent something readable and complete enough to debug from, not to
 * reproduce DevTools.
 *
 * Must stay usable outside a browser (the tests run it under Node), so every
 * DOM reference is guarded with `typeof`.
 */

const DEFAULT_MAX_LENGTH = 10_000;
/** Replacer invocations allowed before the rest collapses to an ellipsis. */
const DEFAULT_MAX_NODES = 5_000;

/** Per-collection cap. Also what keeps any single level from being huge. */
const MAX_ITEMS = 30;

/** How far to follow `cause`. Bounded: cause chains can be circular. */
const MAX_CAUSE_DEPTH = 3;

const ELLIPSIS = "…";

export interface SerializeOptions {
  /** Hard cap on the returned string. Default 10000. */
  maxLength?: number;
  /** Hard cap on visited nodes. Default 5000. */
  maxNodes?: number;
}

/**
 * Shared across every nested render of one argument, so the node budget is
 * global and `seen` closes cycles that run through an error's `cause` or
 * through its own enumerable properties.
 */
interface State {
  budget: number;
  seen: WeakSet<object>;
}

export function serializeArgs(
  args: readonly unknown[],
  options: SerializeOptions = {},
): string[] {
  return args.map((arg) => serializeArg(arg, options));
}

export function serializeArg(value: unknown, options: SerializeOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const state: State = {
    budget: options.maxNodes ?? DEFAULT_MAX_NODES,
    seen: new WeakSet<object>(),
  };
  return clamp(render(value, state), maxLength);
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
  if (maxLength <= 0) return "";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}${ELLIPSIS}`;
}

/**
 * Renders one value. Called for the top-level argument and again for anything
 * reached outside `JSON.stringify` — an error's `cause` and its extra
 * properties — always with the same `state`.
 */
function render(value: unknown, state: State): string {
  if (value === null || typeof value !== "object") return scalar(value);

  const special = specialToString(value, state);
  if (special !== undefined) return special;

  try {
    // The replacer is handed the root first, so `seen` is populated there and
    // the root is not pre-marked here (which would report it as circular).
    return JSON.stringify(value, makeReplacer(state)) ?? scalar(value);
  } catch {
    // A throwing getter or exotic proxy should never take down the caller.
    return fallback(value);
  }
}

/** Renders the values `JSON.stringify` mishandles or drops. */
function scalar(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "bigint":
      return `${value}n`;
    case "symbol":
      return String(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "function": {
      const name = (value as (...args: unknown[]) => unknown).name;
      return name ? `[Function: ${name}]` : "[Function (anonymous)]";
    }
    default:
      return String(value);
  }
}

function fallback(value: object): string {
  try {
    return String(value);
  } catch {
    return `[${value.constructor?.name ?? "unserializable"}]`;
  }
}

/**
 * Objects that carry no useful enumerable properties, and would otherwise
 * serialize as `{}`.
 */
function specialToString(value: object, state: State): string | undefined {
  if (value instanceof Error) return formatError(value, 0, state);
  if (typeof Element !== "undefined" && value instanceof Element) {
    return `<${value.tagName.toLowerCase()}>`;
  }
  if (typeof Node !== "undefined" && value instanceof Node) return `[${value.nodeName}]`;
  if (value instanceof RegExp) return String(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (typeof Map !== "undefined" && value instanceof Map) return `Map(${value.size})`;
  if (typeof Set !== "undefined" && value instanceof Set) return `Set(${value.size})`;
  return undefined;
}

function makeReplacer(state: State): (this: unknown, key: string, value: unknown) => unknown {
  return function replacer(_key: string, value: unknown): unknown {
    if (state.budget <= 0) return ELLIPSIS;
    state.budget--;

    if (value === null) return null;
    if (typeof value !== "object") {
      // Booleans and finite numbers are already valid JSON; everything else
      // would be dropped, mangled, or thrown on.
      if (typeof value === "boolean" || typeof value === "string") return value;
      if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
      return scalar(value);
    }

    // Not path-scoped: an object reached twice reads as circular even when the
    // graph is really a DAG. For reading a log line that distinction does not
    // earn the bookkeeping it costs.
    if (state.seen.has(value)) return "[Circular]";
    state.seen.add(value);

    const special = specialToString(value, state);
    if (special !== undefined) return special;

    // Clipping happens before JSON.stringify descends, so no level is ever
    // wider than MAX_ITEMS and the traversal cannot fan out.
    if (Array.isArray(value)) {
      if (value.length <= MAX_ITEMS) return value;
      return [...value.slice(0, MAX_ITEMS), `${ELLIPSIS}${value.length - MAX_ITEMS} more`];
    }

    const keys = Object.keys(value);
    if (keys.length <= MAX_ITEMS) return value;
    const clipped: Record<string, unknown> = {};
    for (const key of keys.slice(0, MAX_ITEMS)) {
      clipped[key] = (value as Record<string, unknown>)[key];
    }
    clipped[ELLIPSIS] = `${keys.length - MAX_ITEMS} more`;
    return clipped;
  };
}

/**
 * Errors are the reason this module exists, so they keep their stack.
 *
 * `depth` is not decoration: `new Error(a, { cause: b })` wrappers can form a
 * cycle, and following one without a bound is an infinite recursion. `state`
 * closes the mixed case, where the cycle runs through a plain object.
 */
function formatError(err: Error, depth: number, state: State): string {
  const name = err.name || "Error";
  const message = typeof err.message === "string" ? err.message : "";
  const head = message ? `${name}: ${message}` : name;

  const stack = typeof err.stack === "string" ? err.stack : "";
  // V8 stacks already start with "Name: message"; Firefox and Safari do not.
  let out = stack === "" ? head : stack.startsWith(name) ? stack : `${head}\n${stack}`;

  // `code`, `status` and friends are usually the part you act on. `name`,
  // `message` and `cause` are excluded because they are rendered elsewhere and
  // are own-enumerable whenever they were assigned after construction.
  const extras = Object.keys(err).filter(
    (key) => key !== "stack" && key !== "message" && key !== "name" && key !== "cause",
  );
  if (extras.length > 0) {
    const bag: Record<string, unknown> = {};
    for (const key of extras.slice(0, MAX_ITEMS)) {
      try {
        bag[key] = (err as unknown as Record<string, unknown>)[key];
      } catch {
        bag[key] = "[getter threw]";
      }
    }
    out += `\n  ${render(bag, state)}`;
  }

  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out += `\n  [cause] ${
      cause instanceof Error ? formatError(cause, depth + 1, state) : render(cause, state)
    }`;
  }
  return out;
}
